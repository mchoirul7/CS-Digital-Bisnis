import { getStock, listUnitConversions } from "@/lib/business-tools/inventory";
import { validateOrder } from "@/lib/business-tools/orders";
import { cancelOrder, confirmOrder, getOrder, isExplicitOrderConfirmation } from "@/lib/business-tools/order-service";
import type { Checkout, OrderDetail } from "@/lib/business-tools/order-types";
import { getPackagingFact } from "@/lib/business-tools/packaging";
import { getPaymentAccounts } from "@/lib/business-tools/payments";
import { calculateOrder, getPrice } from "@/lib/business-tools/pricing";
import {
  findProductUnit,
  listProductUnits,
  sellableProductUnits,
  toPublicProductUnit,
} from "@/lib/business-tools/product-units";
import {
  getProductById,
  listActiveProducts,
  searchProducts,
  type ProductLookup,
} from "@/lib/business-tools/products";
import { BusinessToolRecorder, type BusinessToolContext } from "@/lib/business-tools/recorder";
import { getDeliveryInformation, requestHumanHandoff } from "@/lib/business-tools/support";
import type {
  BusinessRepository,
  BusinessToolExecution,
  ConversationOwnership,
  HandoffReasonCode,
  Product,
  ProductUnit,
} from "@/lib/business-tools/types";
import type { ConversationState, DraftItem, ProductSource } from "@/lib/chat/conversation-state";
import { buildHandoffMetadata, buildHandoffSummary } from "@/lib/handoff";
import {
  activeItems,
  applyDraftMutation,
  cancelledItems,
  findDraftItem,
  mutationForIntent,
} from "./draft";
import { resolveUnit, unitsAreSame } from "./unit-resolver";
import { validateQuantity } from "./validators";
import type {
  BusinessIntent,
  BusinessResult,
  BusinessResultStatus,
  DraftReview,
  DraftReviewItem,
  OperationResult,
  ProductResolution,
  QuantityValidation,
  RunningDraft,
  SemanticOperation,
  StructuredRequest,
  UnitResolution,
  SupplementaryResult,
} from "./types";
import { mutatesDraft, requiresProduct } from "./types";

export type BusinessEngineInput = {
  customerPhone?: string | null;
  repository: BusinessRepository;
  companyId: string;
  conversationId?: string;
  ownership?: ConversationOwnership;
  request: StructuredRequest;
  state: ConversationState;
  /** Katalog yang sudah dibaca chat service; menghindari query ganda per request. */
  catalog?: Product[];
  /** Diisi kalau katalog gagal dibaca, supaya jawabannya jadi "belum bisa dicek". */
  catalogError?: string;
  /** Pesan mentah customer; hanya dipakai untuk ringkasan handoff ke admin. */
  customerMessage?: string;
  /** Lampiran yang benar-benar diterima request ini (mis. bukti transfer). */
  attachments?: Array<{ name: string; mime_type: string; size: number }>;
};

export type BusinessEngineOutput = {
  result: BusinessResult;
  toolCalls: BusinessToolExecution[];
  productSource: ProductSource;
  /** Draft baru bila turn ini mengubahnya; null berarti draft tidak berubah. */
  draftItems: DraftItem[] | null;
};

function baseResult(request: StructuredRequest, status: BusinessResultStatus, reason: string): BusinessResult {
  return {
    intent: request.intent,
    status,
    product: null,
    product_resolution: null,
    unit_resolution: null,
    requested: {
      product_query: request.product_query,
      quantity: request.quantity,
      unit: request.unit,
    },
    availability: null,
    price: null,
    total: null,
    maximum_available: null,
    shortfall: null,
    stock_sufficient: null,
    unit_match: null,
    order_allowed: false,
    candidates: [],
    suggestions: [],
    listed_products: [],
    pagination: null,
    payment_accounts: [],
    sellable_units: [],
    selected_unit: null,
    packaging: null,
    draft: null,
    running_draft: null,
    operation_results: [],
    pending_clarification: null,
    draft_change: null,
    supplementary: [],
    handoff: { required: false, reason_code: null, handoff_id: null, status: null },
    urgency: request.urgency,
    reason,
  };
}

function unresolvedProductResult(
  request: StructuredRequest,
  resolution: ProductResolution,
): BusinessResult {
  const status: BusinessResultStatus =
    resolution.status === "AMBIGUOUS" ? "PRODUCT_AMBIGUOUS" : "PRODUCT_NOT_FOUND";

  return {
    ...baseResult(request, status, resolution.reason),
    product_resolution: resolution,
    candidates: resolution.candidates.map((candidate) => candidate.product),
    suggestions: resolution.suggestions.map((candidate) => candidate.product),
  };
}

const PRODUCT_LIST_LIMIT = 20;

type ResolvedProduct = ProductLookup | { resolution: ProductResolution; product: null };

/**
 * Kalau query customer ambigu tetapi hanya satu kandidat yang memang sedang/pernah
 * dibahas di percakapan ini, itulah yang dimaksud ("balik indomie"). Memori
 * percakapan hanya dipakai untuk memilih identitas, tidak untuk fakta apa pun.
 */
function narrowByDiscussedProducts(
  resolution: ProductResolution,
  state: ConversationState,
): string | null {
  if (resolution.status !== "AMBIGUOUS") {
    return null;
  }

  const known = new Set([
    ...(state.discussedProducts ?? []).map((product) => product.id),
    ...(state.draftItems ?? []).map((item) => item.productId),
    ...(state.activeProduct ? [state.activeProduct.id] : []),
  ]);

  const matches = resolution.candidates.filter((candidate) => known.has(candidate.product.id));
  return matches.length === 1 ? matches[0].product.id : null;
}

/**
 * Prioritas resolusi rujukan produk:
 * 1. produk yang disebut eksplisit di pesan terakhir
 * 2. kandidat klarifikasi yang sedang ditawarkan
 * 3. produk yang pernah dibahas (untuk query ambigu)
 * 4. activeProduct
 * 5. satu-satunya baris draft yang aktif
 * Kalau semuanya gagal, engine bertanya - tidak menebak.
 */
async function resolveProduct(
  toolContext: BusinessToolContext,
  request: StructuredRequest,
  state: ConversationState,
): Promise<{ lookup: ResolvedProduct; source: ProductSource }> {
  const query = request.product_query?.trim() ?? "";

  if (query) {
    const pendingIds = (state.pendingCandidates ?? []).map((candidate) => candidate.id);

    if (pendingIds.length > 0) {
      const scoped = await searchProducts(toolContext, query, { restrictToProductIds: pendingIds });
      if (scoped.product) {
        return { lookup: scoped, source: "PENDING_CANDIDATE" };
      }
    }

    const lookup = await searchProducts(toolContext, query);

    if (!lookup.product) {
      const narrowed = narrowByDiscussedProducts(lookup.resolution, state);

      if (narrowed) {
        const fromHistory = await getProductById(toolContext, narrowed, query);
        if (fromHistory) {
          return { lookup: fromHistory, source: "CONVERSATION_STATE" };
        }
      }

      // Singkatan seperti "indo grg" tidak bisa dicocokkan deterministik.
      // Tebakan nama katalog dari language layer dicoba sebagai percobaan kedua,
      // dan tetap harus lolos ProductResolver yang sama.
      const hinted = request.catalog_product_name?.trim();

      if (hinted && hinted.toLowerCase() !== query.toLowerCase()) {
        const byHint = await searchProducts(toolContext, hinted);
        if (byHint.product) {
          return { lookup: byHint, source: "EXPLICIT_MESSAGE" };
        }
      }
    }

    return { lookup, source: "EXPLICIT_MESSAGE" };
  }

  if (state.activeProduct) {
    const lookup = await getProductById(
      toolContext,
      state.activeProduct.id,
      state.activeProduct.name,
    );

    if (lookup) {
      return { lookup, source: "CONVERSATION_STATE" };
    }
  }

  // Perubahan draft tanpa menyebut produk ("kurangi 2") boleh diarahkan ke
  // satu-satunya baris yang aktif; kalau lebih dari satu, jangan menebak.
  if (mutatesDraft(request.intent)) {
    const active = activeItems(state.draftItems);

    if (active.length === 1) {
      const lookup = await getProductById(toolContext, active[0].productId, active[0].productName);
      if (lookup) {
        return { lookup, source: "CONVERSATION_STATE" };
      }
    }
  }

  return { lookup: await searchProducts(toolContext, ""), source: "NONE" };
}

async function resolveUnitForProduct(
  toolContext: BusinessToolContext,
  product: Product,
  requestedUnit: string | null | undefined,
  quantity: number | null,
) {
  const exact = resolveUnit({
    requestedUnit: requestedUnit ?? null,
    inventoryUnit: product.unit,
    quantity,
  });

  if (exact.status === "EXACT") {
    return exact;
  }

  const conversions = await listUnitConversions(toolContext, product);

  return resolveUnit({
    requestedUnit: requestedUnit ?? null,
    inventoryUnit: product.unit,
    quantity,
    conversions,
  });
}

const QUANTITY_STEP_EPSILON = 1e-9;

function quantityFitsStep(quantity: number, unit: ProductUnit) {
  const steps = (quantity - unit.min_quantity) / unit.quantity_step;
  return Math.abs(steps - Math.round(steps)) < QUANTITY_STEP_EPSILON;
}

function validateSellableQuantity(quantity: ReturnType<typeof validateQuantity>, unit: ProductUnit) {
  if (quantity.status !== "VALID" || quantity.quantity === null) {
    return quantity;
  }

  if (quantity.quantity < unit.min_quantity) {
    return {
      status: "INVALID_QUANTITY" as const,
      quantity: quantity.quantity,
      reason: "QUANTITY_BELOW_MINIMUM",
    };
  }

  if (!quantityFitsStep(quantity.quantity, unit)) {
    return {
      status: "INVALID_QUANTITY" as const,
      quantity: quantity.quantity,
      reason: "QUANTITY_STEP_MISMATCH",
    };
  }

  return quantity;
}

function unitResolutionFromProductUnit(product: Product, unit: ProductUnit, quantity: number | null) {
  return {
    status: unit.is_base_unit ? ("EXACT" as const) : ("CONVERTIBLE" as const),
    requested_unit: unit.unit_code,
    inventory_unit: product.unit,
    unit_match: true,
    conversion: unit.is_base_unit
      ? null
      : { factor: unit.conversion_to_base, source: "product_units" },
    quantity_in_inventory_unit:
      quantity === null ? null : Number((quantity * unit.conversion_to_base).toFixed(6)),
    reason: unit.is_base_unit ? "SELLABLE_BASE_UNIT" : "SELLABLE_UNIT_CONVERTED_TO_BASE",
  };
}

function quantityForSelectedUnit(
  quantity: QuantityValidation,
  unit: UnitResolution,
  selectedUnit: ProductUnit,
) {
  if (quantity.status !== "VALID" || quantity.quantity === null) {
    return quantity.quantity;
  }

  if (
    unit.quantity_in_inventory_unit === null ||
    (unit.requested_unit && unitsAreSame(unit.requested_unit, selectedUnit.unit_code)) ||
    selectedUnit.conversion_to_base <= 0
  ) {
    return quantity.quantity;
  }

  return Number((unit.quantity_in_inventory_unit / selectedUnit.conversion_to_base).toFixed(6));
}

function draftUnitForRequest(requestedUnit: string | null | undefined, selectedUnit: ProductUnit) {
  return requestedUnit?.trim() || selectedUnit.unit_code;
}

type SellableUnitDecision =
  | {
      status: "OK";
      selectedUnit: ProductUnit;
      sellableUnits: ProductUnit[];
      quantity: QuantityValidation;
      unitResolution: UnitResolution;
      reason: string;
    }
  | {
      status: "SELLABLE_UNIT_REQUIRED" | "UNIT_NOT_SELLABLE" | "SELLABLE_UNIT_POLICY_UNAVAILABLE";
      selectedUnit: ProductUnit | null;
      sellableUnits: ProductUnit[];
      quantity: QuantityValidation;
      unitResolution: UnitResolution;
      reason: string;
    };

async function resolveSellableUnitPolicy(
  toolContext: BusinessToolContext,
  product: Product,
  requestedUnit: string | null | undefined,
  quantity: ReturnType<typeof validateQuantity>,
): Promise<SellableUnitDecision> {
  const units = await listProductUnits(toolContext, product);
  const sellableUnits = sellableProductUnits(units);
  const fallbackUnit = await resolveUnitForProduct(
    toolContext,
    product,
    requestedUnit ?? null,
    quantity.quantity,
  );

  if (sellableUnits.length === 0) {
    return {
      status: "SELLABLE_UNIT_POLICY_UNAVAILABLE",
      selectedUnit: null,
      sellableUnits,
      quantity,
      unitResolution: fallbackUnit,
      reason: "SELLABLE_UNIT_POLICY_UNAVAILABLE",
    };
  }

  const requested = requestedUnit?.trim() ? findProductUnit(units, requestedUnit) : null;

  if (requestedUnit?.trim()) {
    if (!requested?.is_sellable) {
      const baseUnit = sellableUnits.find(
        (unit) => unit.is_base_unit || unitsAreSame(unit.unit_code, product.unit),
      );

      if (!requested && fallbackUnit.status === "CONVERTIBLE" && baseUnit) {
        return {
          status: "OK",
          selectedUnit: baseUnit,
          sellableUnits,
          quantity,
          unitResolution: fallbackUnit,
          reason: "SELLABLE_BASE_UNIT_FROM_OFFICIAL_CONVERSION",
        };
      }

      return {
        status: "UNIT_NOT_SELLABLE",
        selectedUnit: null,
        sellableUnits,
        quantity,
        unitResolution: fallbackUnit,
        reason: "UNIT_NOT_SELLABLE",
      };
    }

    const checkedQuantity = validateSellableQuantity(quantity, requested);

    return {
      status: "OK",
      selectedUnit: requested,
      sellableUnits,
      quantity: checkedQuantity,
      unitResolution: unitResolutionFromProductUnit(product, requested, checkedQuantity.quantity),
      reason: "SELLABLE_UNIT_FROM_REQUEST",
    };
  }

  if (sellableUnits.length > 1) {
    return {
      status: "SELLABLE_UNIT_REQUIRED",
      selectedUnit: null,
      sellableUnits,
      quantity,
      unitResolution: fallbackUnit,
      reason: "MULTIPLE_SELLABLE_UNITS",
    };
  }

  const selected = sellableUnits[0];
  const checkedQuantity = validateSellableQuantity(quantity, selected);

  return {
    status: "OK",
    selectedUnit: selected,
    sellableUnits,
    quantity: checkedQuantity,
    unitResolution: unitResolutionFromProductUnit(product, selected, checkedQuantity.quantity),
    reason: "ONLY_SELLABLE_UNIT_SELECTED",
  };
}

function toRunningDraft(items: DraftItem[]): RunningDraft {
  return {
    items: activeItems(items).map((item) => ({
      product_id: item.productId,
      product_name: item.productName,
      quantity: item.quantity,
      unit: item.unit,
    })),
    cancelled: cancelledItems(items).map((item) => ({
      product_id: item.productId,
      product_name: item.productName,
    })),
  };
}

function operationResult(
  operation: SemanticOperation,
  status: OperationResult["status"],
  reason: string,
  extra: Partial<OperationResult> = {},
): OperationResult {
  return {
    action: operation.action,
    status,
    requested_query: operation.product_query,
    requested_quantity: operation.quantity,
    requested_unit: operation.unit,
    product_id: null,
    product_name: null,
    applied_quantity: null,
    applied_unit: null,
    catalog_unit: null,
    stock_quantity: null,
    price: null,
    total: null,
    stock_sufficient: null,
    candidates: [],
    reason,
    ...extra,
  };
}

type OperationRunOutcome = {
  result: OperationResult;
  items: DraftItem[];
  productSource: ProductSource;
  product: Product | null;
};

/**
 * Menjalankan satu operasi semantik terhadap draft yang sedang berjalan.
 * Operasi yang gagal mengembalikan draft apa adanya - tidak pernah menjatuhkan
 * operasi lain dalam pesan yang sama.
 */
async function runOperation(
  toolContext: BusinessToolContext,
  operation: SemanticOperation,
  state: ConversationState,
  items: DraftItem[],
): Promise<OperationRunOutcome> {
  const workingState: ConversationState = { ...state, draftItems: items };

  // Operasi yang sudah dipatok ke produk tertentu (lanjutan klarifikasi).
  const pinned = operation.product_id
    ? await getProductById(toolContext, operation.product_id, operation.product_query ?? "")
    : null;

  const resolved = pinned
    ? { lookup: pinned, source: "CONVERSATION_STATE" as ProductSource }
    : await resolveProduct(
        toolContext,
        {
          intent: operation.action,
          product_query: operation.product_query,
          catalog_product_name: operation.catalog_product_name,
        } as StructuredRequest,
        workingState,
      );

  if (!resolved.lookup.product) {
    const resolution = resolved.lookup.resolution;
    return {
      result: operationResult(
        operation,
        resolution.status === "AMBIGUOUS" ? "PRODUCT_AMBIGUOUS" : "PRODUCT_NOT_FOUND",
        resolution.reason,
        { candidates: resolution.candidates.map((candidate) => candidate.product.name) },
      ),
      items,
      productSource: "NONE",
      product: null,
    };
  }

  const product = resolved.lookup.product;
  const base = {
    product_id: product.id,
    product_name: product.name,
    catalog_unit: product.unit,
  };

  const existing = findDraftItem(items, product.id);

  if (operation.action === "REMOVE_ITEM" || operation.action === "RESTORE_ITEM") {
    const mutation = mutationForIntent(operation.action, operation.quantity);
    const applied = mutation
      ? applyDraftMutation({
          items,
          mutation,
          product: { id: product.id, name: product.name },
          unit: operation.unit ?? existing?.unit ?? product.unit,
        })
      : null;

    if (!applied?.changed) {
      return {
        result: operationResult(operation, "NOT_IN_DRAFT", "DRAFT_ITEM_NOT_IN_LIST", base),
        items,
        productSource: resolved.source,
        product,
      };
    }

    return {
      result: operationResult(operation, "APPLIED", `DRAFT_${applied.outcome}`, {
        ...base,
        applied_quantity: applied.changed.quantity,
        applied_unit: applied.changed.unit,
      }),
      items: applied.items,
      productSource: resolved.source,
      product,
    };
  }

  const currentQuantity = existing && existing.status === "ACTIVE" ? existing.quantity : 0;
  const targetQuantity =
    operation.quantity === null
      ? null
      : operation.action === "INCREMENT_ITEM"
        ? currentQuantity + operation.quantity
        : operation.action === "DECREMENT_ITEM"
          ? currentQuantity - operation.quantity
          : operation.quantity;

  // "kurangi 5" dari 5 dus berarti barisnya dibatalkan.
  if (operation.action === "DECREMENT_ITEM" && targetQuantity !== null && targetQuantity <= 0) {
    const applied = applyDraftMutation({
      items,
      mutation: { kind: "REMOVE" },
      product: { id: product.id, name: product.name },
      unit: operation.unit ?? product.unit,
    });

    return {
      result: applied.changed
        ? operationResult(operation, "APPLIED", "DRAFT_REMOVED", {
            ...base,
            applied_quantity: applied.changed.quantity,
            applied_unit: applied.changed.unit,
          })
        : operationResult(operation, "NOT_IN_DRAFT", "DRAFT_ITEM_NOT_IN_LIST", base),
      items: applied.changed ? applied.items : items,
      productSource: resolved.source,
      product,
    };
  }

  const policy = await resolveSellableUnitPolicy(
    toolContext,
    product,
    operation.unit,
    validateQuantity(targetQuantity),
  );

  if (policy.status === "SELLABLE_UNIT_POLICY_UNAVAILABLE") {
    throw new Error(policy.reason);
  }

  if (policy.status === "UNIT_NOT_SELLABLE") {
    return {
      result: operationResult(operation, "UNIT_NOT_SELLABLE", policy.reason, {
        ...base,
        candidates: policy.sellableUnits.map((unit) => unit.unit_code),
      }),
      items,
      productSource: resolved.source,
      product,
    };
  }

  if (policy.status === "SELLABLE_UNIT_REQUIRED") {
    return {
      result: operationResult(operation, "SELLABLE_UNIT_REQUIRED", policy.reason, {
        ...base,
        candidates: policy.sellableUnits.map((unit) => unit.unit_code),
      }),
      items,
      productSource: resolved.source,
      product,
    };
  }

  const quantity = policy.quantity;
  const unit = policy.unitResolution;
  const selectedUnit = policy.selectedUnit;

  if (!selectedUnit) {
    throw new Error("SELLABLE_UNIT_POLICY_UNAVAILABLE");
  }

  if (quantity.status === "MISSING") {
    return {
      result: operationResult(operation, "QUANTITY_REQUIRED", quantity.reason, {
        ...base,
        catalog_unit: selectedUnit.unit_code,
      }),
      items,
      productSource: resolved.source,
      product,
    };
  }

  if (quantity.status === "INVALID_QUANTITY") {
    return {
      result: operationResult(operation, "INVALID_QUANTITY", quantity.reason, base),
      items,
      productSource: resolved.source,
      product,
    };
  }

  const effectiveQuantity = unit.quantity_in_inventory_unit ?? 0;
  const stock = await getStock(toolContext, product);

  if (effectiveQuantity > stock.quantity) {
    return {
      result: operationResult(operation, "INSUFFICIENT_STOCK", "INSUFFICIENT_STOCK", {
        ...base,
        stock_quantity: stock.quantity,
      }),
      items,
      productSource: resolved.source,
      product,
    };
  }

  const applied = applyDraftMutation({
    items,
    mutation: { kind: "SET", quantity: quantity.quantity ?? 0 },
    product: { id: product.id, name: product.name },
    unit: draftUnitForRequest(operation.unit, selectedUnit),
  });

  return {
    result: operationResult(operation, "APPLIED", `DRAFT_${applied.outcome}`, {
      ...base,
      applied_quantity: applied.changed?.quantity ?? quantity.quantity,
      applied_unit: applied.changed?.unit ?? selectedUnit.unit_code,
      stock_quantity: stock.quantity,
    }),
    items: applied.items,
    productSource: resolved.source,
    product,
  };
}

type ProductIntentOutcome = {
  result: BusinessResult;
  productSource: ProductSource;
  product: Product | null;
  draftItems: DraftItem[] | null;
};

async function runProductIntent(
  toolContext: BusinessToolContext,
  request: StructuredRequest,
  state: ConversationState,
): Promise<ProductIntentOutcome> {
  const { lookup, source } = await resolveProduct(toolContext, request, state);

  if (!lookup.product) {
    return {
      result: unresolvedProductResult(request, lookup.resolution),
      productSource: "NONE",
      product: null,
      draftItems: null,
    };
  }

  const product: Product = lookup.product;
  const resolution = lookup.resolution;
  const found = {
    ...baseResult(request, "PRODUCT_FOUND", resolution.reason),
    product: resolution.product,
    product_resolution: resolution,
  };

  const done = (result: BusinessResult, draftItems: DraftItem[] | null = null) => ({
    result,
    productSource: source,
    product,
    draftItems,
  });

  if (request.intent === "PRODUCT_SEARCH") {
    return done(found);
  }

  if (request.intent === "STOCK_CHECK") {
    const stock = await getStock(toolContext, product);
    const price = await getPrice(toolContext, product);

    return done({
      ...found,
      status: stock.quantity > 0 ? "STOCK_AVAILABLE" : "OUT_OF_STOCK",
      availability: { quantity: stock.quantity, unit: stock.unit },
      price: price.unit_price,
      maximum_available: stock.quantity,
      stock_sufficient: stock.quantity > 0,
      reason: stock.quantity > 0 ? "STOCK_AND_PRICE_FROM_DATABASE" : "STOCK_EMPTY_PRICE_FROM_DATABASE",
    });
  }

  if (request.intent === "PRICE_CHECK") {
    const price = await getPrice(toolContext, product);

    return done({
      ...found,
      status: "PRICE_AVAILABLE",
      price: price.unit_price,
      reason: "PRICE_FROM_DATABASE",
    });
  }

  if (request.intent === "PACKAGING_INFO") {
    const packaging = await getPackagingFact(toolContext, product);

    return done({
      ...found,
      packaging,
      status: packaging ? "PACKAGING_INFO_AVAILABLE" : "PACKAGING_DATA_UNAVAILABLE",
      reason: packaging ? "PACKAGING_FROM_DATABASE" : "PACKAGING_NOT_IN_SYSTEM",
    });
  }

  if (request.intent === "RETAIL_AVAILABILITY") {
    // Penjualan eceran adalah aturan bisnis, bukan tebakan. Selama tidak ada
    // data satuan yang lebih kecil, jawabannya "belum bisa dipastikan".
    const packaging = await getPackagingFact(toolContext, product);

    return done({
      ...found,
      packaging,
      status: "RETAIL_AVAILABILITY_UNKNOWN",
      reason: "RETAIL_RULE_NOT_IN_SYSTEM",
    });
  }

  const existingItem = findDraftItem(state.draftItems, product.id);

  // Membatalkan / mengaktifkan kembali baris draft tidak perlu cek stok.
  if (request.intent === "REMOVE_ITEM" || request.intent === "RESTORE_ITEM") {
    const mutation = mutationForIntent(request.intent, request.quantity);

    if (!mutation) {
      return done({ ...found, status: "DRAFT_ITEM_UNRESOLVED", reason: "DRAFT_ACTION_INCOMPLETE" });
    }

    const applied = applyDraftMutation({
      items: state.draftItems,
      mutation,
      product: { id: product.id, name: product.name },
      unit: request.unit ?? existingItem?.unit ?? product.unit,
    });

    if (!applied.changed) {
      return done({ ...found, status: "DRAFT_ITEM_UNRESOLVED", reason: "DRAFT_ITEM_NOT_IN_LIST" });
    }

    return done(
      {
        ...found,
        status: request.intent === "REMOVE_ITEM" ? "ITEM_REMOVED" : "ITEM_RESTORED",
        reason: request.intent === "REMOVE_ITEM" ? "DRAFT_ITEM_CANCELLED" : "DRAFT_ITEM_RESTORED",
        draft_change: {
          action: request.intent,
          product_name: applied.changed.productName,
          quantity: applied.changed.quantity,
          unit: applied.changed.unit,
          active_item_count: activeItems(applied.items).length,
        },
      },
      applied.items,
    );
  }

  // QUOTE dan aksi draft berjumlah: jumlah dan satuan harus lolos validasi
  // sebelum angka apa pun boleh dihitung.
  const currentDraftQuantity =
    existingItem && existingItem.status === "ACTIVE" ? existingItem.quantity : 0;

  const requestedQuantity = (() => {
    if (request.quantity === null) {
      return null;
    }

    if (request.intent === "INCREMENT_ITEM") {
      return currentDraftQuantity + request.quantity;
    }

    if (request.intent === "DECREMENT_ITEM") {
      return currentDraftQuantity - request.quantity;
    }

    return request.quantity;
  })();

  const policy = await resolveSellableUnitPolicy(
    toolContext,
    product,
    request.unit ?? (request.intent === "ORDER_REQUEST" ? null : existingItem?.unit),
    validateQuantity(requestedQuantity),
  );

  if (policy.status === "SELLABLE_UNIT_POLICY_UNAVAILABLE") {
    return done({
      ...found,
      status: "DATA_UNAVAILABLE",
      reason: policy.reason,
      sellable_units: policy.sellableUnits.map(toPublicProductUnit),
      unit_resolution: policy.unitResolution,
      unit_match: policy.unitResolution.unit_match,
    });
  }

  const quantity = policy.quantity;
  const unit = policy.unitResolution;
  const selectedUnit = policy.selectedUnit;

  const withRequestDetails: BusinessResult = {
    ...found,
    requested: { ...found.requested, quantity: requestedQuantity },
    unit_resolution: unit,
    unit_match: unit.unit_match,
    sellable_units: policy.sellableUnits.map(toPublicProductUnit),
    selected_unit: selectedUnit ? toPublicProductUnit(selectedUnit) : null,
  };

  if (policy.status === "UNIT_NOT_SELLABLE") {
    return done({
      ...withRequestDetails,
      status: "NEEDS_CLARIFICATION",
      order_allowed: false,
      reason: policy.reason,
    });
  }

  if (policy.status === "SELLABLE_UNIT_REQUIRED") {
    return done({
      ...withRequestDetails,
      status: "SELLABLE_UNIT_REQUIRED",
      order_allowed: false,
      reason: policy.reason,
    });
  }

  if (!selectedUnit) {
    return done({
      ...withRequestDetails,
      status: "DATA_UNAVAILABLE",
      order_allowed: false,
      reason: "SELLABLE_UNIT_POLICY_UNAVAILABLE",
    });
  }

  // "kurangi 5" dari 5 dus berarti barisnya dibatalkan, bukan jumlah tidak valid.
  if (request.intent === "DECREMENT_ITEM" && requestedQuantity !== null && requestedQuantity <= 0) {
    const applied = applyDraftMutation({
      items: state.draftItems,
      mutation: { kind: "REMOVE" },
      product: { id: product.id, name: product.name },
      unit: request.unit ?? product.unit,
    });

    if (!applied.changed) {
      return done({ ...found, status: "DRAFT_ITEM_UNRESOLVED", reason: "DRAFT_ITEM_NOT_IN_LIST" });
    }

    return done(
      {
        ...withRequestDetails,
        status: "ITEM_REMOVED",
        reason: "DRAFT_ITEM_CANCELLED",
        draft_change: {
          action: request.intent,
          product_name: applied.changed.productName,
          quantity: applied.changed.quantity,
          unit: applied.changed.unit,
          active_item_count: activeItems(applied.items).length,
        },
      },
      applied.items,
    );
  }

  if (quantity.status === "INVALID_QUANTITY") {
    return done({ ...withRequestDetails, status: "INVALID_QUANTITY", reason: quantity.reason });
  }

  if (unit.status === "NEEDS_CLARIFICATION") {
    return done({
      ...withRequestDetails,
      status: "NEEDS_CLARIFICATION",
      reason: unit.reason,
    });
  }

  if (quantity.status === "MISSING") {
    if (request.intent === "QUOTE") {
      const price = await getPrice(toolContext, product, selectedUnit);
      return done({
        ...withRequestDetails,
        status: "PRICE_AVAILABLE",
        price: price.unit_price,
        reason: "PRICE_FROM_DATABASE",
      });
    }

    return done({ ...withRequestDetails, status: "QUANTITY_REQUIRED", reason: quantity.reason });
  }

  const effectiveQuantity = unit.quantity_in_inventory_unit ?? 0;
  const stock = await getStock(toolContext, product);
  const price = await getPrice(toolContext, product, selectedUnit);
  const sufficient = effectiveQuantity <= stock.quantity;

  const factual: BusinessResult = {
    ...withRequestDetails,
    availability: { quantity: stock.quantity, unit: stock.unit },
    maximum_available: stock.quantity,
    price: price.unit_price,
    stock_sufficient: sufficient,
    shortfall: sufficient ? null : Number((effectiveQuantity - stock.quantity).toFixed(3)),
  };

  if (request.intent === "QUOTE") {
    // Penawaran boleh dihitung walaupun stok kurang, asalkan hasilnya menyatakan
    // stok tidak mencukupi.
    const calculation = await calculateOrder(toolContext, {
      product,
      quantity: quantityForSelectedUnit(quantity, unit, selectedUnit) ?? 0,
      unit: selectedUnit.unit_code,
      unitPrice: price.unit_price,
    });

    return done({
      ...factual,
      status: "QUOTE_CREATED",
      total: calculation.total_price,
      order_allowed: false,
      reason: sufficient ? "QUOTE_WITH_SUFFICIENT_STOCK" : "QUOTE_WITH_INSUFFICIENT_STOCK",
    });
  }

  const validation = await validateOrder(toolContext, {
    product,
    quantity,
    unit,
    productUnit: selectedUnit,
    stockQuantity: stock.quantity,
  });

  if (!validation.order_allowed) {
    // Draft tidak diubah kalau jumlahnya tidak bisa dipenuhi.
    return done({
      ...factual,
      status: validation.reason === "INSUFFICIENT_STOCK" ? "INSUFFICIENT_STOCK" : "NEEDS_CLARIFICATION",
      order_allowed: false,
      reason: validation.reason,
    });
  }

  const mutation = mutationForIntent(request.intent, quantity.quantity);
  const applied = mutation
    ? applyDraftMutation({
        items: state.draftItems,
        mutation: { kind: "SET", quantity: quantity.quantity ?? 0 },
        product: { id: product.id, name: product.name },
        unit: draftUnitForRequest(request.unit, selectedUnit),
      })
    : null;

  // ORDER_REQUEST (ADD_ITEM) mempertahankan status lamanya supaya kontrak
  // "pesanan baru sampai tahap konfirmasi" tidak berubah.
  const status: BusinessResultStatus =
    request.intent === "ORDER_REQUEST" ? "READY_FOR_CONFIRMATION" : "ITEM_UPDATED";

  return done(
    {
      ...factual,
      status,
      // Selama customer masih memilih barang, jangan menutup dengan total -
      // total baru dihitung saat review pesanan.
      total: null,
      price: null,
      order_allowed: true,
      reason: "ORDER_READY_FOR_CONFIRMATION",
      draft_change: applied?.changed
        ? {
            action: request.intent,
            product_name: applied.changed.productName,
            quantity: applied.changed.quantity,
            unit: applied.changed.unit,
            active_item_count: activeItems(applied.items).length,
          }
        : null,
    },
    applied?.items ?? null,
  );
}

const MULTI_PRODUCT_OPERATION_INTENTS: BusinessIntent[] = [
  "PRODUCT_SEARCH",
  "STOCK_CHECK",
  "PRICE_CHECK",
  "QUOTE",
];

function canRunMultiProductOperations(request: StructuredRequest) {
  return (
    request.operations.length > 1 &&
    request.operations.every((operation) =>
      MULTI_PRODUCT_OPERATION_INTENTS.includes(operation.action),
    )
  );
}

type ProductOperationOutcome = {
  result: OperationResult;
  productSource: ProductSource;
  product: Product | null;
  resolution: ProductResolution | null;
};

/**
 * Menjawab satu operasi baca produk (stok/harga/quote) tanpa mengubah draft.
 * Dipakai saat customer menanyakan beberapa produk dalam satu pesan. Setiap
 * produk tetap di-resolve dan dibaca faktanya sendiri-sendiri.
 */
async function runProductQueryOperation(
  toolContext: BusinessToolContext,
  operation: SemanticOperation,
  state: ConversationState,
): Promise<ProductOperationOutcome> {
  const resolved = await resolveProduct(
    toolContext,
    {
      intent: operation.action,
      product_query: operation.product_query,
      catalog_product_name: operation.catalog_product_name,
      quantity: operation.quantity,
      unit: operation.unit,
      operations: [operation],
      secondary_intents: [],
      urgency: false,
      tone: "neutral",
    },
    state,
  );

  if (!resolved.lookup.product) {
    const resolution = resolved.lookup.resolution;

    return {
      result: operationResult(
        operation,
        resolution.status === "AMBIGUOUS" ? "PRODUCT_AMBIGUOUS" : "PRODUCT_NOT_FOUND",
        resolution.reason,
        {
          candidates: [
            ...resolution.candidates.map((candidate) => candidate.product.name),
            ...resolution.suggestions.map((candidate) => candidate.product.name),
          ],
        },
      ),
      productSource: "NONE",
      product: null,
      resolution,
    };
  }

  const product = resolved.lookup.product;
  const base = {
    product_id: product.id,
    product_name: product.name,
    catalog_unit: product.unit,
  };

  if (operation.action === "PRODUCT_SEARCH") {
    return {
      result: operationResult(operation, "APPLIED", "PRODUCT_FOUND", base),
      productSource: resolved.source,
      product,
      resolution: resolved.lookup.resolution,
    };
  }

  if (operation.action === "STOCK_CHECK") {
    const stock = await getStock(toolContext, product);
    const price = await getPrice(toolContext, product);

    return {
      result: operationResult(
        operation,
        "APPLIED",
        stock.quantity > 0 ? "STOCK_AVAILABLE" : "OUT_OF_STOCK",
        {
          ...base,
          applied_unit: stock.unit,
          stock_quantity: stock.quantity,
          price: price.unit_price,
          stock_sufficient: stock.quantity > 0,
        },
      ),
      productSource: resolved.source,
      product,
      resolution: resolved.lookup.resolution,
    };
  }

  if (operation.action === "PRICE_CHECK") {
    const price = await getPrice(toolContext, product);

    return {
      result: operationResult(operation, "APPLIED", "PRICE_AVAILABLE", {
        ...base,
        applied_unit: price.unit,
        price: price.unit_price,
      }),
      productSource: resolved.source,
      product,
      resolution: resolved.lookup.resolution,
    };
  }

  const policy = await resolveSellableUnitPolicy(
    toolContext,
    product,
    operation.unit,
    validateQuantity(operation.quantity),
  );

  if (policy.status === "SELLABLE_UNIT_POLICY_UNAVAILABLE") {
    throw new Error(policy.reason);
  }

  if (policy.status === "UNIT_NOT_SELLABLE") {
    return {
      result: operationResult(operation, "UNIT_NOT_SELLABLE", policy.reason, {
        ...base,
        candidates: policy.sellableUnits.map((unit) => unit.unit_code),
      }),
      productSource: resolved.source,
      product,
      resolution: resolved.lookup.resolution,
    };
  }

  if (policy.status === "SELLABLE_UNIT_REQUIRED") {
    return {
      result: operationResult(operation, "SELLABLE_UNIT_REQUIRED", policy.reason, {
        ...base,
        candidates: policy.sellableUnits.map((unit) => unit.unit_code),
      }),
      productSource: resolved.source,
      product,
      resolution: resolved.lookup.resolution,
    };
  }

  const quantity = policy.quantity;
  const unit = policy.unitResolution;
  const selectedUnit = policy.selectedUnit;

  if (!selectedUnit) {
    throw new Error("SELLABLE_UNIT_POLICY_UNAVAILABLE");
  }

  if (quantity.status === "INVALID_QUANTITY") {
    return {
      result: operationResult(operation, "INVALID_QUANTITY", quantity.reason, base),
      productSource: resolved.source,
      product,
      resolution: resolved.lookup.resolution,
    };
  }

  if (quantity.status === "MISSING") {
    const price = await getPrice(toolContext, product, selectedUnit);

    return {
      result: operationResult(operation, "APPLIED", "PRICE_AVAILABLE", {
        ...base,
        applied_unit: price.unit,
        price: price.unit_price,
      }),
      productSource: resolved.source,
      product,
      resolution: resolved.lookup.resolution,
    };
  }

  const effectiveQuantity = unit.quantity_in_inventory_unit ?? 0;
  const stock = await getStock(toolContext, product);
  const price = await getPrice(toolContext, product, selectedUnit);
  const calculation = await calculateOrder(toolContext, {
    product,
    quantity: quantityForSelectedUnit(quantity, unit, selectedUnit) ?? 0,
    unit: selectedUnit.unit_code,
    unitPrice: price.unit_price,
  });
  const sufficient = effectiveQuantity <= stock.quantity;

  return {
    result: operationResult(operation, "APPLIED", "QUOTE_CREATED", {
      ...base,
      applied_quantity: quantity.quantity,
      applied_unit: selectedUnit.unit_code,
      stock_quantity: stock.quantity,
      price: price.unit_price,
      total: calculation.total_price,
      stock_sufficient: sufficient,
    }),
    productSource: resolved.source,
    product,
    resolution: resolved.lookup.resolution,
  };
}

async function runProductOperations(
  toolContext: BusinessToolContext,
  request: StructuredRequest,
  state: ConversationState,
): Promise<ProductIntentOutcome> {
  const outcomes: ProductOperationOutcome[] = [];

  for (const operation of request.operations) {
    outcomes.push(await runProductQueryOperation(toolContext, operation, state));
  }

  const firstResolved = outcomes.find((outcome) => outcome.product);

  return {
    result: {
      ...baseResult(request, "MULTI_PRODUCT_RESULT", "MULTI_PRODUCT_OPERATIONS_FROM_DATABASE"),
      product: firstResolved?.product
        ? {
            id: firstResolved.product.id,
            sku: firstResolved.product.sku,
            name: firstResolved.product.name,
            description: firstResolved.product.description,
            unit: firstResolved.product.unit,
          }
        : null,
      product_resolution: firstResolved?.resolution ?? null,
      operation_results: outcomes.map((outcome) => outcome.result),
    },
    productSource: firstResolved?.productSource ?? "NONE",
    product: firstResolved?.product ?? null,
    draftItems: null,
  };
}

/**
 * Menjalankan beberapa operasi dari satu pesan. Setiap operasi diselesaikan
 * sendiri-sendiri terhadap draft yang terus bertambah, sehingga satu operasi
 * yang butuh klarifikasi tidak membatalkan operasi lain yang sudah valid.
 */
async function runDraftOperations(
  toolContext: BusinessToolContext,
  request: StructuredRequest,
  state: ConversationState,
): Promise<ProductIntentOutcome> {
  let items = state.draftItems ?? [];
  const results: OperationResult[] = [];
  let productSource: ProductSource = "NONE";
  let product: Product | null = null;

  for (const operation of request.operations) {
    const outcome = await runOperation(toolContext, operation, state, items);
    results.push(outcome.result);
    items = outcome.items;

    if (outcome.product && !product) {
      product = outcome.product;
      productSource = outcome.productSource;
    }
  }

  const applied = results.filter((result) => result.status === "APPLIED");
  const pending = results.find((result) => result.status === "NEEDS_UNIT_CLARIFICATION") ?? null;

  const status: BusinessResultStatus =
    applied.length === 0
      ? "DRAFT_ITEM_UNRESOLVED"
      : applied.length === results.length
        ? "DRAFT_UPDATED"
        : "DRAFT_PARTIALLY_UPDATED";

  const result: BusinessResult = {
    ...baseResult(
      request,
      status,
      applied.length === results.length
        ? "ALL_OPERATIONS_APPLIED"
        : applied.length > 0
          ? "SOME_OPERATIONS_NEED_CLARIFICATION"
          : "NO_OPERATION_APPLIED",
    ),
    product: product ? { id: product.id, sku: product.sku, name: product.name, description: product.description, unit: product.unit } : null,
    operation_results: results,
    running_draft: toRunningDraft(items),
    pending_clarification: pending
      ? {
          product_id: pending.product_id ?? "",
          product_name: pending.product_name ?? "",
          catalog_unit: pending.catalog_unit ?? "",
          requested_quantity: pending.requested_quantity,
          requested_unit: pending.requested_unit,
        }
      : null,
  };

  return { result, productSource, product, draftItems: items };
}

/**
 * Ringkasan pesanan. Setiap baris divalidasi ulang ke database: produk masih
 * aktif, harga sekarang, dan stok sekarang. Tidak ada satu angka pun yang
 * diambil dari ingatan percakapan.
 */
async function runOrderReview(
  toolContext: BusinessToolContext,
  request: StructuredRequest,
  state: ConversationState,
): Promise<BusinessResult> {
  const active = activeItems(state.draftItems);

  if (active.length === 0) {
    return baseResult(request, "DRAFT_EMPTY", "DRAFT_HAS_NO_ACTIVE_ITEM");
  }

  const items: DraftReviewItem[] = [];
  const checkout: Checkout = { key: crypto.randomUUID(), items: [] };
  let grandTotal = 0;
  let allAvailable = true;

  for (const item of active) {
    const lookup = await getProductById(toolContext, item.productId, item.productName);

    if (!lookup?.product) {
      allAvailable = false;
      items.push({
        product_id: item.productId,
        product_name: item.productName,
        quantity: item.quantity,
        unit: item.unit,
        inventory_unit: item.unit,
        unit_price: null,
        subtotal: null,
        stock_quantity: null,
        stock_sufficient: false,
        shortfall: null,
        issue: "PRODUCT_INACTIVE",
      });
      continue;
    }

    const product = lookup.product;
    const policy = await resolveSellableUnitPolicy(
      toolContext,
      product,
      item.unit,
      validateQuantity(item.quantity),
    );

    if (policy.status !== "OK" || policy.unitResolution.quantity_in_inventory_unit === null) {
      allAvailable = false;
      items.push({
        product_id: product.id,
        product_name: product.name,
        quantity: item.quantity,
        unit: item.unit,
        inventory_unit: product.unit,
        unit_price: null,
        subtotal: null,
        stock_quantity: null,
        stock_sufficient: false,
        shortfall: null,
        issue: "UNIT_UNCLEAR",
      });
      continue;
    }

    const unit = policy.unitResolution;
    const selectedUnit = policy.selectedUnit;
    const stock = await getStock(toolContext, product);
    const price = await getPrice(toolContext, product, selectedUnit);
    const effective = unit.quantity_in_inventory_unit ?? 0;
    const sufficient = effective <= stock.quantity;

    const calculation = await calculateOrder(toolContext, {
      product,
      quantity: quantityForSelectedUnit(validateQuantity(item.quantity), unit, selectedUnit) ?? 0,
      unit: selectedUnit.unit_code,
      unitPrice: price.unit_price,
    });

    if (!sufficient) {
      allAvailable = false;
    }

    grandTotal = Math.round((grandTotal + calculation.total_price) * 100) / 100;
    checkout.items.push({ product_id: product.id, quantity: calculation.quantity, unit: selectedUnit.unit_code,
      unit_price: price.unit_price, conversion_to_base: selectedUnit.conversion_to_base });

    items.push({
      product_id: product.id,
      product_name: product.name,
      quantity: item.quantity,
      unit: item.unit,
      inventory_unit: product.unit,
      unit_price: price.unit_price,
      subtotal: calculation.total_price,
      stock_quantity: stock.quantity,
      stock_sufficient: sufficient,
      shortfall: sufficient ? null : Number((effective - stock.quantity).toFixed(3)),
      issue: sufficient ? "NONE" : "INSUFFICIENT_STOCK",
    });
  }

  const draft: DraftReview = {
    items,
    cancelled_items: cancelledItems(state.draftItems).map((item) => ({
      product_id: item.productId,
      product_name: item.productName,
    })),
    grand_total: grandTotal,
    all_available: allAvailable,
  };

  return {
    ...baseResult(
      request,
      allAvailable ? "ORDER_REVIEWED" : "ORDER_REVIEW_NEEDS_ADJUSTMENT",
      allAvailable ? "ORDER_REVIEW_FROM_CURRENT_DATA" : "ORDER_REVIEW_HAS_UNAVAILABLE_ITEM",
    ),
    draft,
    checkout: allAvailable ? checkout : undefined,
    total: grandTotal,
    order_allowed: false,
  };
}

async function runOrderFinalization(
  toolContext: BusinessToolContext,
  request: StructuredRequest,
  state: ConversationState,
  customerMessage: string,
  phone?: string | null,
): Promise<BusinessResult> {
  if (!isExplicitOrderConfirmation(customerMessage)) {
    return baseResult(request, "ORDER_CONFIRMATION_FAILED", "EXPLICIT_CONFIRMATION_REQUIRED");
  }
  const key = state.checkout?.key ?? (activeItems(state.draftItems).length === 0 ? state.lastCheckoutKey : undefined);
  if (!key) return runOrderReview(toolContext, request, state);
  try {
    const order = await confirmOrder(toolContext, key, customerMessage, phone);
    return persistedOrderResult(request, order, state.checkout ? "ORDER_CONFIRMED" : "DUPLICATE_CONFIRMATION");
  } catch (error) {
    const message = error instanceof Error ? error.message : "ORDER_CONFIRMATION_FAILED";
    const code = ["INSUFFICIENT_STOCK", "QUOTE_CHANGED", "PRODUCT_INACTIVE", "UNKNOWN_UNIT", "INVALID_CONVERSION",
      "PRICE_UNAVAILABLE", "INVALID_QUANTITY", "CONFIRMATION_REVIEW_REQUIRED"].find((value) => message.includes(value));
    return baseResult(request, "ORDER_CONFIRMATION_FAILED", code ?? "ORDER_CONFIRMATION_FAILED");
  }
}

function persistedOrderResult(request: StructuredRequest, order: OrderDetail, reason: string): BusinessResult {
  return { ...baseResult(request, order.status === "cancelled" ? "ORDER_CANCELLED" : "ORDER_PERSISTED", reason),
    persisted_order: order, total: order.total, order_allowed: order.status !== "cancelled",
    draft: { items: order.items.map((item) => ({ product_id: item.product_id, product_name: item.product_name,
      quantity: item.quantity, unit: item.unit, inventory_unit: item.unit, unit_price: item.unit_price,
      subtotal: item.subtotal, stock_quantity: null, stock_sufficient: true, shortfall: null, issue: "NONE" })),
      cancelled_items: [], grand_total: order.total, all_available: true } };
}

/**
 * Pertanyaan tambahan dalam pesan yang sama. Hanya kapabilitas yang murah dan
 * tidak mengubah keputusan utama yang dijawab di sini.
 */
async function runSupplementaryIntents(
  toolContext: BusinessToolContext,
  intents: BusinessIntent[],
  product: Product | null,
): Promise<SupplementaryResult[]> {
  const results: SupplementaryResult[] = [];
  const seen = new Set<BusinessIntent>();

  for (const intent of intents) {
    if (seen.has(intent)) {
      continue;
    }
    seen.add(intent);

    if (intent === "PAYMENT_INFO") {
      const accounts = await getPaymentAccounts(toolContext);
      results.push({
        intent,
        status: "PAYMENT_ACCOUNTS",
        reason: "PAYMENT_ACCOUNTS_FROM_DATABASE",
        packaging: null,
        payment_accounts: accounts,
      });
      continue;
    }

    if (intent === "DELIVERY_CHECK") {
      await getDeliveryInformation(toolContext, null);
      results.push({
        intent,
        status: "DELIVERY_UNAVAILABLE",
        reason: "DELIVERY_SCHEDULE_NOT_IN_SYSTEM",
        packaging: null,
        payment_accounts: [],
      });
      continue;
    }

    if (!product) {
      continue;
    }

    if (intent === "PACKAGING_INFO") {
      const packaging = await getPackagingFact(toolContext, product);
      results.push({
        intent,
        status: packaging ? "PACKAGING_INFO_AVAILABLE" : "PACKAGING_DATA_UNAVAILABLE",
        reason: packaging ? "PACKAGING_FROM_DATABASE" : "PACKAGING_NOT_IN_SYSTEM",
        packaging,
        payment_accounts: [],
      });
      continue;
    }

    if (intent === "RETAIL_AVAILABILITY") {
      results.push({
        intent,
        status: "RETAIL_AVAILABILITY_UNKNOWN",
        reason: "RETAIL_RULE_NOT_IN_SYSTEM",
        packaging: null,
        payment_accounts: [],
      });
    }
  }

  return results;
}

/** Berapa kali berturut-turut AI boleh gagal sebelum percakapan diserahkan ke admin. */
const UNRESOLVED_TURNS_BEFORE_HANDOFF = 2;

/**
 * Keputusan apakah percakapan ini butuh manusia. Bukan berdasarkan kalimat
 * persis customer, tetapi berdasarkan apakah business engine punya wewenang dan
 * data untuk menjawabnya.
 */
function decideHandoff(
  request: StructuredRequest,
  result: BusinessResult,
  state: ConversationState,
): { reasonCode: HandoffReasonCode; reason: string } | null {
  if (request.intent === "HUMAN_HANDOFF") {
    return { reasonCode: "CUSTOMER_REQUESTED_HUMAN", reason: "CUSTOMER_ASKED_FOR_HUMAN" };
  }

  // Bukti transfer yang benar-benar diterima wajib dicek manusia; klaim lisan
  // "sudah transfer" belum perlu merepotkan admin karena buktinya belum ada.
  if (result.status === "PAYMENT_PROOF_RECEIVED") {
    return { reasonCode: "PAYMENT_VERIFICATION", reason: "PAYMENT_PROOF_NEEDS_HUMAN_VERIFICATION" };
  }

  if (request.intent === "COMPLAINT") {
    const paymentRelated =
      request.secondary_intents.includes("PAYMENT_INFO") ||
      result.reason === "COMPLAINT_ABOUT_PAYMENT";

    return paymentRelated
      ? { reasonCode: "PAYMENT_ISSUE", reason: "PAYMENT_COMPLAINT_NO_AUTOMATION" }
      : { reasonCode: "COMPLAINT", reason: "COMPLAINT_NO_AUTOMATION" };
  }

  if (request.intent === "DISCOUNT_REQUEST") {
    return request.quantity !== null
      ? { reasonCode: "SPECIAL_PRICE_REQUEST", reason: "NO_SPECIAL_PRICE_RULE_IN_SYSTEM" }
      : { reasonCode: "DISCOUNT_REQUEST", reason: "NO_DISCOUNT_RULE_IN_SYSTEM" };
  }

  if (request.intent === "DELIVERY_CHECK" && request.urgency) {
    return { reasonCode: "DELIVERY_UNVERIFIED", reason: "DELIVERY_CERTAINTY_REQUIRED" };
  }

  if (result.status === "DATA_UNAVAILABLE") {
    return { reasonCode: "BUSINESS_DATA_UNAVAILABLE", reason: "BUSINESS_DATA_READ_FAILED" };
  }

  const previousFailures = state.unresolvedTurns ?? 0;

  if (previousFailures >= UNRESOLVED_TURNS_BEFORE_HANDOFF) {
    if (result.status === "PRODUCT_AMBIGUOUS" || result.status === "PRODUCT_NOT_FOUND") {
      return {
        reasonCode: "PRODUCT_AMBIGUOUS_UNRESOLVED",
        reason: "PRODUCT_STILL_UNRESOLVED_AFTER_CLARIFICATION",
      };
    }

    if (result.status === "NO_BUSINESS_REQUEST") {
      return { reasonCode: "AI_UNCERTAIN", reason: "INTENT_STILL_UNCLEAR" };
    }
  }

  return null;
}

/**
 * Business engine generik: satu alur untuk semua produk dan semua cara bicara
 * customer. Tidak ada cabang khusus per nama produk atau per kalimat.
 */
export async function processBusinessRequest(
  input: BusinessEngineInput,
): Promise<BusinessEngineOutput> {
  const recorder = new BusinessToolRecorder();
  const toolContext: BusinessToolContext = {
    repository: input.repository,
    companyId: input.companyId,
    conversationId: input.conversationId,
    ownership: input.ownership,
    catalog: input.catalog,
    recorder,
  };

  const request = input.request;

  try {
    if (input.catalogError) {
      throw new Error(input.catalogError);
    }

    let result: BusinessResult;
    let productSource: ProductSource = "NONE";
    let product: Product | null = null;
    let draftItems: DraftItem[] | null = null;

    if (request.intent === "GREETING") {
      result = baseResult(request, "GREETING_RESPONSE", "GREETING_ONLY");
    } else if (request.intent === "THANKS") {
      result = baseResult(request, "THANKS_RESPONSE", "THANKS_ONLY");
    } else if (request.intent === "PRODUCT_LIST") {
      const listed = await listActiveProducts(toolContext, { limit: PRODUCT_LIST_LIMIT, offset: 0 });
      result = {
        ...baseResult(request, "PRODUCT_LISTED", "ACTIVE_PRODUCTS_FROM_DATABASE"),
        listed_products: listed.products,
        pagination: {
          limit: listed.limit,
          offset: listed.offset,
          has_more: listed.has_more,
        },
      };
    } else if (request.intent === "CLEAR_DRAFT") {
      if (!activeItems(input.state.draftItems).length && input.state.lastOrderId
        && /^(?:tolong\s+)?(?:batal(?:kan)?|cancel)(?:\s+(?:semua|seluruh|pesanan(?:nya)?|order(?:nya)?|saya|ini|kak))+[.!\s]*$/i.test(input.customerMessage ?? "")) {
        const existing = await getOrder(toolContext, input.state.lastOrderId);
        if (!existing || existing.conversation_id !== input.conversationId) throw new Error("ORDER_NOT_FOUND");
        try {
          result = persistedOrderResult(request, await cancelOrder(toolContext, existing.id), "ORDER_CANCELLED_BY_CUSTOMER");
        } catch {
          result = baseResult(request, "ORDER_CONFIRMATION_FAILED", "INVALID_ORDER_TRANSITION");
        }
        draftItems = [];
      } else {
      const applied = applyDraftMutation({
        items: input.state.draftItems,
        mutation: { kind: "CLEAR" },
        product: null,
        unit: "",
      });

      const hadItems = activeItems(input.state.draftItems).length > 0;
      result = baseResult(
        request,
        hadItems ? "DRAFT_CLEARED" : "DRAFT_EMPTY",
        hadItems ? "DRAFT_CLEARED_BY_CUSTOMER" : "DRAFT_HAS_NO_ACTIVE_ITEM",
      );
      draftItems = hadItems ? applied.items : null;
      }
    } else if (request.intent === "ORDER_REVIEW") {
      result = await runOrderReview(toolContext, request, input.state);
    } else if (request.intent === "ORDER_CONFIRMED") {
      result = await runOrderFinalization(toolContext, request, input.state, input.customerMessage ?? "", input.customerPhone);
    } else if (request.intent === "PAYMENT_REPORTED") {
      // Belum ada verifikasi pembayaran otomatis: minta buktinya dulu,
      // jangan langsung membebani admin dan jangan mengaku uangnya masuk.
      result = baseResult(request, "PAYMENT_PROOF_REQUESTED", "PAYMENT_PROOF_NOT_YET_RECEIVED");
    } else if (request.intent === "PAYMENT_PROOF_SUBMITTED") {
      const attachments = input.attachments ?? [];

      result =
        attachments.length === 0
          ? baseResult(request, "PAYMENT_PROOF_MISSING", "NO_ATTACHMENT_RECEIVED")
          : baseResult(request, "PAYMENT_PROOF_RECEIVED", "PAYMENT_PROOF_RECEIVED_NOT_VERIFIED");
    } else if (mutatesDraft(request.intent) && request.operations.length > 1) {
      const outcome = await runDraftOperations(toolContext, request, input.state);
      result = outcome.result;
      productSource = outcome.productSource;
      product = outcome.product;
      draftItems = outcome.draftItems;
    } else if (canRunMultiProductOperations(request)) {
      const outcome = await runProductOperations(toolContext, request, input.state);
      result = outcome.result;
      productSource = outcome.productSource;
      product = outcome.product;
      draftItems = outcome.draftItems;
    } else if (requiresProduct(request.intent) || mutatesDraft(request.intent)) {
      const outcome = await runProductIntent(toolContext, request, input.state);
      result = outcome.result;
      productSource = outcome.productSource;
      product = outcome.product;
      draftItems = outcome.draftItems;
    } else if (request.intent === "PAYMENT_INFO") {
      const accounts = await getPaymentAccounts(toolContext);
      result =
        accounts.length === 0
          ? baseResult(request, "DATA_UNAVAILABLE", "PAYMENT_ACCOUNT_UNAVAILABLE")
          : {
              ...baseResult(request, "PAYMENT_ACCOUNTS", "PAYMENT_ACCOUNTS_FROM_DATABASE"),
              payment_accounts: accounts,
            };
    } else if (request.intent === "DELIVERY_CHECK") {
      await getDeliveryInformation(toolContext, request.product_query);
      result = baseResult(request, "DELIVERY_UNAVAILABLE", "DELIVERY_SCHEDULE_NOT_IN_SYSTEM");
    } else if (request.intent === "DISCOUNT_REQUEST") {
      result = baseResult(request, "DISCOUNT_NOT_AVAILABLE", "NO_DISCOUNT_RULE_IN_SYSTEM");
    } else if (request.intent === "COMPLAINT") {
      result = baseResult(request, "COMPLAINT_ESCALATED", "COMPLAINT_NO_AUTOMATION");
    } else if (request.intent === "HUMAN_HANDOFF") {
      result = baseResult(request, "HANDOFF_CREATED", "HANDOFF_CREATED");
    } else {
      result = baseResult(request, "NO_BUSINESS_REQUEST", "NO_BUSINESS_REQUEST");
    }

    // Setiap perubahan draft dijawab dengan seluruh isi pesanan, bukan hanya
    // baris terakhir, supaya customer merasa satu pesanan yang sama terus
    // dipegang.
    if (mutatesDraft(request.intent) || request.intent === "ORDER_REVIEW") {
      const currentItems = draftItems ?? input.state.draftItems ?? [];

      if (!result.running_draft) {
        result = { ...result, running_draft: toRunningDraft(currentItems) };
      }

      if (!result.pending_clarification && result.status === "NEEDS_CLARIFICATION" && result.product) {
        result = {
          ...result,
          pending_clarification: {
            product_id: result.product.id,
            product_name: result.product.name,
            catalog_unit: result.unit_resolution?.inventory_unit ?? result.product.unit,
            requested_quantity: result.requested.quantity,
            requested_unit: result.requested.unit,
          },
        };
      }
    }

    if (request.secondary_intents.length > 0) {
      const supplementary = await runSupplementaryIntents(
        toolContext,
        request.secondary_intents.filter((intent) => intent !== request.intent),
        product,
      );

      if (supplementary.length > 0) {
        result = { ...result, supplementary };
      }
    }

    const decision = decideHandoff(request, result, input.state);

    if (decision) {
      const handoff = await requestHumanHandoff(toolContext, {
        reasonCode: decision.reasonCode,
        reason: decision.reason,
        summary: buildHandoffSummary({
          reasonCode: decision.reasonCode,
          customerMessage: input.customerMessage ?? "",
          result,
        }),
        metadata: buildHandoffMetadata(result),
      });

      result = {
        ...result,
        handoff: {
          required: true,
          reason_code: decision.reasonCode,
          handoff_id: handoff.handoff_id,
          status: handoff.status,
        },
      };
    }

    return { result, toolCalls: recorder.list(), productSource, draftItems };
  } catch (error) {
    let failure = baseResult(
      request,
      "DATA_UNAVAILABLE",
      error instanceof Error ? `DATA_UNAVAILABLE: ${error.message}` : "DATA_UNAVAILABLE",
    );

    // Data bisnis gagal dibaca: customer tidak boleh diberi angka karangan,
    // jadi percakapannya diserahkan ke admin - kalau pencatatannya pun gagal,
    // jawabannya tetap aman, hanya tanpa handoff.
    try {
      const handoff = await requestHumanHandoff(toolContext, {
        reasonCode: "BUSINESS_DATA_UNAVAILABLE",
        reason: "BUSINESS_DATA_READ_FAILED",
        summary: buildHandoffSummary({
          reasonCode: "BUSINESS_DATA_UNAVAILABLE",
          customerMessage: input.customerMessage ?? "",
          result: failure,
        }),
        metadata: buildHandoffMetadata(failure),
      });

      failure = {
        ...failure,
        handoff: {
          required: true,
          reason_code: "BUSINESS_DATA_UNAVAILABLE",
          handoff_id: handoff.handoff_id,
          status: handoff.status,
        },
      };
    } catch {
      failure = {
        ...failure,
        handoff: {
          required: true,
          reason_code: "BUSINESS_DATA_UNAVAILABLE",
          handoff_id: null,
          status: null,
        },
      };
    }

    return { result: failure, toolCalls: recorder.list(), productSource: "NONE", draftItems: null };
  }
}
