import { z } from "zod";
import type { Checkout } from "@/lib/business-tools/order-types";
import { businessIntentSchema, mutatesDraft, requiresProduct } from "@/lib/business/types";
import type { BusinessIntent, BusinessResult, StructuredRequest } from "@/lib/business/types";

/**
 * Discourse memory percakapan. Isinya hanya "customer sedang membicarakan apa",
 * bukan fakta bisnis. Stok, harga, total, ketersediaan, dan rekening TIDAK
 * pernah disimpan di sini - semuanya selalu dibaca ulang dari database.
 */
export type ActiveProduct = {
  id: string;
  name: string;
  unit: string;
};

export type PendingCandidate = {
  id: string;
  name: string;
};

/** Produk yang pernah dibahas, supaya "balik indomie" bisa diselesaikan. */
export type DiscussedProduct = {
  id: string;
  name: string;
  unit: string;
  lastReferencedAt: string;
};

/**
 * Baris draft pesanan. Hanya identitas produk, jumlah, dan satuan yang diminta
 * customer. Harga, subtotal, dan stok TIDAK disimpan di sini - semuanya dibaca
 * ulang saat review.
 */
export type DraftItem = {
  productId: string;
  productName: string;
  quantity: number;
  unit: string;
  status: "ACTIVE" | "CANCELLED";
  updatedAt: string;
};

export type OrderPhase =
  | "BROWSING"
  | "ORDER_BUILDING"
  | "ORDER_REVIEW"
  | "PAYMENT"
  | "HUMAN_HANDOFF";

/** Operasi yang menunggu jawaban customer, mis. satuannya belum jelas. */
export type PendingOperation = {
  action: BusinessIntent;
  productId: string;
  productName: string;
  catalogUnit: string;
  requestedQuantity: number | null;
  requestedUnit: string | null;
};

export type ConversationState = {
  checkout?: Checkout;
  lastOrderId?: string;
  lastCheckoutKey?: string;
  activeProduct?: ActiveProduct;
  pendingOperation?: PendingOperation;
  discussedProducts?: DiscussedProduct[];
  draftItems?: DraftItem[];
  orderPhase?: OrderPhase;
  previousIntent?: BusinessIntent;
  pendingIntent?: BusinessIntent;
  pendingQuantity?: number | null;
  pendingUnit?: string | null;
  pendingCandidates?: PendingCandidate[];
  awaitingClarification?: boolean;
  awaitingConfirmation?: boolean;
  /** Berapa kali berturut-turut AI gagal memahami maksud customer. */
  unresolvedTurns?: number;
};

export const conversationStateSchema = z
  .object({
    checkout: z.object({
      key: z.uuid(),
      items: z.array(z.object({ product_id: z.uuid(), quantity: z.number().positive(), unit: z.string(),
        unit_price: z.number().nonnegative(), conversion_to_base: z.number().positive() })).min(1).max(50),
    }).optional(),
    lastOrderId: z.uuid().optional(),
    lastCheckoutKey: z.uuid().optional(),
    activeProduct: z
      .object({
        id: z.string().max(64),
        name: z.string().max(200),
        unit: z.string().max(40),
      })
      .optional(),
    discussedProducts: z
      .array(
        z.object({
          id: z.string().max(64),
          name: z.string().max(200),
          unit: z.string().max(40),
          lastReferencedAt: z.string().max(40),
        }),
      )
      .max(20)
      .optional(),
    draftItems: z
      .array(
        z.object({
          productId: z.string().max(64),
          productName: z.string().max(200),
          quantity: z.number().finite().positive(),
          unit: z.string().max(40),
          status: z.enum(["ACTIVE", "CANCELLED"]),
          updatedAt: z.string().max(40),
        }),
      )
      .max(50)
      .optional(),
    orderPhase: z
      .enum(["BROWSING", "ORDER_BUILDING", "ORDER_REVIEW", "PAYMENT", "HUMAN_HANDOFF"])
      .optional(),
    pendingOperation: z
      .object({
        action: businessIntentSchema,
        productId: z.string().max(64),
        productName: z.string().max(200),
        catalogUnit: z.string().max(40),
        requestedQuantity: z.number().finite().nullable(),
        requestedUnit: z.string().max(40).nullable(),
      })
      .optional(),
    previousIntent: businessIntentSchema.optional(),
    pendingIntent: businessIntentSchema.optional(),
    pendingQuantity: z.number().finite().nullable().optional(),
    pendingUnit: z.string().max(40).nullable().optional(),
    pendingCandidates: z
      .array(z.object({ id: z.string().max(64), name: z.string().max(200) }))
      .max(10)
      .optional(),
    awaitingClarification: z.boolean().optional(),
    awaitingConfirmation: z.boolean().optional(),
    unresolvedTurns: z.number().int().min(0).max(50).optional(),
  })
  .strip();

export function parseConversationState(value: unknown): ConversationState {
  const parsed = conversationStateSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

/** Dari mana identitas produk pada turn ini berasal. */
export type ProductSource =
  | "EXPLICIT_MESSAGE"
  | "CONVERSATION_STATE"
  | "PENDING_CANDIDATE"
  | "NONE";

export type ContextResolution = {
  request: StructuredRequest;
  state: ConversationState;
  /** Rencana asal produk sebelum resolver jalan; hasil finalnya dilaporkan engine. */
  plannedProductSource: ProductSource;
  inheritedIntent: boolean;
  inheritedQuantity: boolean;
  inheritedUnit: boolean;
  notes: string[];
};

const REFERENCE_INTENTS: BusinessIntent[] = ["PRODUCT_SEARCH", "UNKNOWN"];

/**
 * Menggabungkan structured request dengan ConversationState menjadi satu request
 * yang bisa diproses business engine. Di sinilah kalimat elliptical bahasa
 * Indonesia ("berapa?", "kalau 5 dus?", "eh 10 aja") mewarisi produk, jumlah,
 * dan maksud dari turn sebelumnya.
 *
 * Aturan yang tidak boleh dilanggar: entity eksplisit dari customer selalu
 * mengalahkan konteks.
 */
export function resolveConversationContext(
  request: StructuredRequest,
  state: ConversationState,
): ContextResolution {
  const notes: string[] = [];
  const hasExplicitProduct = Boolean(request.product_query?.trim());
  const pendingCandidates = state.pendingCandidates ?? [];

  let intent = request.intent;
  let quantity = request.quantity;
  let unit = request.unit;
  let inheritedIntent = false;
  let inheritedQuantity = false;
  let inheritedUnit = false;

  const inheritQuantityAndUnit = () => {
    if (quantity === null && state.pendingQuantity !== null && state.pendingQuantity !== undefined) {
      quantity = state.pendingQuantity;
      inheritedQuantity = true;
    }

    if (!unit && state.pendingUnit) {
      unit = state.pendingUnit;
      inheritedUnit = true;
    }
  };

  // Prioritas tertinggi: customer menjawab klarifikasi yang barusan ditanyakan.
  // "1 karton aja" harus menyambung ke Gula yang tertunda, bukan ke produk lain.
  const pendingOperation = state.pendingOperation;
  const answersPendingOperation =
    Boolean(pendingOperation) &&
    !hasExplicitProduct &&
    (quantity !== null || Boolean(unit)) &&
    request.operations.length <= 1;

  if (pendingOperation && answersPendingOperation) {
    intent = pendingOperation.action;
    inheritedIntent = true;
    quantity = quantity ?? pendingOperation.requestedQuantity;
    notes.push("ANSWERING_PENDING_OPERATION");
  } else if (intent === "CONFIRMATION") {
    // "gas" / "oke lanjut" hanya berarti sesuatu kalau memang ada yang menunggu.
    if (state.lastOrderId && !(state.draftItems ?? []).some((item) => item.status === "ACTIVE")) {
      intent = "ORDER_CONFIRMED";
      inheritedIntent = true;
    } else if (state.orderPhase === "ORDER_REVIEW" && state.awaitingConfirmation) {
      // Customer menyetujui rangkuman akhir: lanjut ke instruksi pembayaran.
      intent = "ORDER_CONFIRMED";
      inheritedIntent = true;
      notes.push("CONFIRMATION_AFTER_REVIEW_TREATED_AS_ORDER_CONFIRMED");
    } else if ((state.draftItems ?? []).some((item) => item.status === "ACTIVE")) {
      intent = "ORDER_REVIEW";
      inheritedIntent = true;
    } else if (state.awaitingConfirmation && state.pendingIntent && state.activeProduct) {
      intent = state.pendingIntent;
      inheritedIntent = true;
      inheritQuantityAndUnit();
      notes.push("CONFIRMATION_RESOLVED_FROM_PENDING");
    } else if ((state.draftItems ?? []).some((item) => item.status === "ACTIVE")) {
      // "udah", "oke lanjut", "cukup" saat daftar belanja sudah terisi berarti
      // customer minta dirangkum, bukan menyetujui sesuatu yang belum ada.
      intent = "ORDER_REVIEW";
      inheritedIntent = true;
      notes.push("CONFIRMATION_TREATED_AS_ORDER_REVIEW");
    } else if (state.activeProduct) {
      intent = "STOCK_CHECK";
      inheritedIntent = true;
      notes.push("CONFIRMATION_WITHOUT_PENDING_TREATED_AS_STOCK_CHECK");
    } else {
      intent = "UNKNOWN";
      notes.push("CONFIRMATION_WITHOUT_CONTEXT");
    }
  } else if (hasExplicitProduct && pendingCandidates.length > 0 && REFERENCE_INTENTS.includes(intent)) {
    // Customer sedang menjawab pertanyaan klarifikasi varian.
    if (state.pendingIntent) {
      intent = state.pendingIntent;
      inheritedIntent = true;
    }
    inheritQuantityAndUnit();
    notes.push("ANSWERING_CLARIFICATION");
  } else if (
    !hasExplicitProduct &&
    quantity !== null &&
    (state.activeProduct || (state.draftItems ?? []).some((item) => item.status === "ACTIVE"))
  ) {
    // Angka telanjang sebagai kelanjutan: "5 dus?", "eh 10 aja", "20 dus deh".
    if (REFERENCE_INTENTS.includes(intent)) {
      intent = state.awaitingConfirmation && state.pendingIntent ? state.pendingIntent : "QUOTE";
      inheritedIntent = true;
      notes.push("BARE_QUANTITY_CONTINUATION");
    }
  } else if (
    !hasExplicitProduct &&
    REFERENCE_INTENTS.includes(intent) &&
    pendingCandidates.length === 0 &&
    state.pendingIntent &&
    state.activeProduct
  ) {
    // "gimana?" / "jadi?" setelah pertanyaan yang belum selesai.
    intent = state.pendingIntent;
    inheritedIntent = true;
    inheritQuantityAndUnit();
    notes.push("REUSED_PENDING_INTENT");
  }

  // Pertanyaan klarifikasi varian masih terbuka dan customer belum menyebut
  // produk: lebih baik bertanya lagi daripada diam-diam memakai produk lama.
  const clarificationOpen =
    !hasExplicitProduct && pendingCandidates.length > 0 && Boolean(state.awaitingClarification);

  const effectiveState: ConversationState = clarificationOpen
    ? { ...state, activeProduct: undefined }
    : state;

  if (clarificationOpen) {
    notes.push("CLARIFICATION_STILL_OPEN");
  }

  // Aksi terhadap draft yang tidak punya draft sama sekali bukan aksi draft:
  // customer sekadar kembali membicarakan produknya.
  if ((intent === "RESTORE_ITEM" || intent === "REMOVE_ITEM") && (state.draftItems ?? []).length === 0) {
    intent = "PRODUCT_SEARCH";
    inheritedIntent = true;
    notes.push("DRAFT_ACTION_WITHOUT_DRAFT_TREATED_AS_PRODUCT_REFERENCE");
  }

  let plannedProductSource: ProductSource = "NONE";

  if (pendingOperation && answersPendingOperation) {
    plannedProductSource = "CONVERSATION_STATE";
  } else if (hasExplicitProduct) {
    plannedProductSource = pendingCandidates.length > 0 ? "PENDING_CANDIDATE" : "EXPLICIT_MESSAGE";
  } else if (
    (requiresProduct(intent) || mutatesDraft(intent)) &&
    (effectiveState.activeProduct || (effectiveState.draftItems ?? []).some((item) => item.status === "ACTIVE"))
  ) {
    plannedProductSource = "CONVERSATION_STATE";
    notes.push("PRODUCT_INHERITED_FROM_ACTIVE_PRODUCT");
  }

  // Operasi tunggal ikut hasil resolusi konteks; pesan multi-operasi sudah
  // eksplisit menyebut produknya masing-masing, jadi dibiarkan apa adanya.
  const operations =
    request.operations.length <= 1
      ? [
          {
            action: intent,
            product_query: request.product_query,
            catalog_product_name: request.catalog_product_name,
            product_id:
              pendingOperation && answersPendingOperation ? pendingOperation.productId : null,
            quantity,
            unit,
          },
        ]
      : request.operations;

  return {
    request: { ...request, intent, quantity, unit, operations },
    state: effectiveState,
    plannedProductSource,
    inheritedIntent,
    inheritedQuantity,
    inheritedUnit,
    notes,
  };
}

/** Produk hanya boleh dipercaya sebagai activeProduct kalau resolusinya pasti. */
const SAFE_FUZZY_CONFIDENCE = 0.8;

function isVerifiedResolution(result: BusinessResult) {
  const resolution = result.product_resolution;

  if (!resolution || !result.product) {
    return false;
  }

  if (resolution.status === "EXACT") {
    return true;
  }

  return resolution.status === "FUZZY_SAFE" && resolution.confidence >= SAFE_FUZZY_CONFIDENCE;
}

const UNRESOLVED_STATUSES = new Set(["NO_BUSINESS_REQUEST", "PRODUCT_NOT_FOUND", "DATA_UNAVAILABLE"]);

/**
 * State untuk turn berikutnya, disusun dari hasil business engine - bukan dari
 * teks jawaban AI.
 *
 * Prinsip penting: produk yang sudah berhasil dikenali tetap menjadi
 * activeProduct walaupun kapabilitas lain pada pesan yang sama gagal dijawab
 * (mis. data isi per dus belum tercatat).
 */
const PAYMENT_STATUSES = new Set([
  "PAYMENT_ACCOUNTS",
  "PAYMENT_INSTRUCTIONS",
  "PAYMENT_PROOF_REQUESTED",
  "PAYMENT_PROOF_MISSING",
  "PAYMENT_PROOF_RECEIVED",
  "PAYMENT_VERIFICATION_REQUIRED",
]);

function nextOrderPhase(
  previous: ConversationState,
  result: BusinessResult,
  draftItems: DraftItem[],
): OrderPhase {
  if (PAYMENT_STATUSES.has(result.status)) {
    return "PAYMENT";
  }

  if (result.status === "ORDER_REVIEWED" || result.status === "ORDER_REVIEW_NEEDS_ADJUSTMENT") {
    return "ORDER_REVIEW";
  }

  if (draftItems.some((item) => item.status === "ACTIVE")) {
    return "ORDER_BUILDING";
  }

  return previous.orderPhase === "PAYMENT" ? "PAYMENT" : "BROWSING";
}

function rememberDiscussedProduct(
  previous: ConversationState,
  product: { id: string; name: string; unit: string } | null,
  timestamp: string,
): DiscussedProduct[] | undefined {
  if (!product) {
    return previous.discussedProducts;
  }

  const others = (previous.discussedProducts ?? []).filter((item) => item.id !== product.id);
  return [...others, { ...product, lastReferencedAt: timestamp }].slice(-10);
}

export function nextConversationState(
  previous: ConversationState,
  request: StructuredRequest,
  result: BusinessResult,
  draftItems: DraftItem[] | null = null,
): ConversationState {
  const unresolvedTurns = UNRESOLVED_STATUSES.has(result.status)
    ? (previous.unresolvedTurns ?? 0) + 1
    : 0;

  const nextDraft = draftItems ?? previous.draftItems ?? [];
  const timestamp = new Date().toISOString();

  // Klarifikasi yang belum terjawab dibawa ke turn berikutnya; begitu operasinya
  // berhasil diterapkan, penantiannya dilepas.
  const pendingOperation = result.pending_clarification
    ? {
        action: request.intent,
        productId: result.pending_clarification.product_id,
        productName: result.pending_clarification.product_name,
        catalogUnit: result.pending_clarification.catalog_unit,
        requestedQuantity: result.pending_clarification.requested_quantity,
        requestedUnit: result.pending_clarification.requested_unit,
      }
    : undefined;

  const resolvedPendingOperation =
    previous.pendingOperation &&
    result.operation_results.some(
      (operation) =>
        operation.status === "APPLIED" &&
        operation.product_id === previous.pendingOperation?.productId,
    );

  const base: ConversationState = {
    lastOrderId: previous.lastOrderId,
    lastCheckoutKey: previous.lastCheckoutKey,
    activeProduct: previous.activeProduct,
    discussedProducts: previous.discussedProducts,
    draftItems: nextDraft.length > 0 ? nextDraft : undefined,
    orderPhase: nextOrderPhase(previous, result, nextDraft),
    previousIntent: request.intent === "UNKNOWN" ? previous.previousIntent : request.intent,
    ...(pendingOperation
      ? { pendingOperation }
      : resolvedPendingOperation || result.operation_results.length > 0
        ? {}
        : previous.pendingOperation
          ? { pendingOperation: previous.pendingOperation }
          : {}),
    ...(unresolvedTurns > 0 ? { unresolvedTurns } : {}),
  };

  if (result.persisted_order) {
    return { ...base, draftItems: undefined, checkout: undefined, pendingOperation: undefined,
      awaitingConfirmation: false, lastOrderId: result.persisted_order.id,
      lastCheckoutKey: result.persisted_order.checkout_key,
      orderPhase: result.persisted_order.status === "cancelled" ? "BROWSING" : "PAYMENT" };
  }

  if (result.status === "ORDER_REVIEWED") {
    return { ...base, checkout: result.checkout, pendingIntent: "ORDER_CONFIRMED", awaitingConfirmation: true };
  }

  if (result.status === "PRODUCT_AMBIGUOUS") {
    return {
      ...base,
      pendingCandidates: result.candidates.map((product) => ({ id: product.id, name: product.name })),
      pendingIntent: request.intent,
      pendingQuantity: request.quantity,
      pendingUnit: request.unit,
      awaitingClarification: true,
    };
  }

  if (result.status === "PRODUCT_NOT_FOUND") {
    if (result.suggestions.length === 0) {
      // Produknya tidak dikenali sama sekali: jangan menebak, tetapi konteks
      // produk sebelumnya juga tidak perlu dibuang.
      return base;
    }

    return {
      ...base,
      pendingCandidates: result.suggestions.map((product) => ({ id: product.id, name: product.name })),
      pendingIntent: request.intent,
      pendingQuantity: request.quantity,
      pendingUnit: request.unit,
      awaitingClarification: true,
    };
  }

  if (!isVerifiedResolution(result) || !result.product) {
    return base;
  }

  const activeProduct: ActiveProduct = {
    id: result.product.id,
    name: result.product.name,
    unit: result.product.unit,
  };

  const resolved: ConversationState = {
    ...base,
    activeProduct,
    discussedProducts: rememberDiscussedProduct(previous, activeProduct, timestamp),
  };

  if (result.status === "READY_FOR_CONFIRMATION") {
    return {
      ...resolved,
      pendingIntent: "ORDER_REQUEST",
      pendingQuantity: request.quantity,
      pendingUnit: result.requested.unit ?? result.product.unit,
      awaitingConfirmation: true,
    };
  }

  if (result.status === "INSUFFICIENT_STOCK" && result.maximum_available !== null) {
    return {
      ...resolved,
      pendingIntent: "ORDER_REQUEST",
      pendingQuantity: result.maximum_available,
      pendingUnit: result.product.unit,
      awaitingConfirmation: true,
    };
  }

  if (result.status === "NEEDS_CLARIFICATION") {
    return {
      ...resolved,
      pendingIntent: request.intent,
      pendingQuantity: request.quantity,
      pendingUnit: null,
      awaitingClarification: true,
    };
  }

  if (result.status === "QUANTITY_REQUIRED") {
    return {
      ...resolved,
      pendingIntent: request.intent,
      pendingQuantity: null,
      pendingUnit: request.unit,
      awaitingClarification: true,
    };
  }

  return resolved;
}
