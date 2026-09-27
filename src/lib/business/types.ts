import { z } from "zod";
import type { Checkout, OrderDetail } from "@/lib/business-tools/order-types";
import type {
  PublicListedProduct,
  PublicPaymentAccount,
  PublicProduct,
  PublicProductUnit,
} from "@/lib/business-tools/types";

/**
 * Intent yang boleh dihasilkan oleh language understanding layer.
 * Layer ini hanya boleh mengklasifikasikan maksud customer, bukan memutuskan
 * fakta bisnis apa pun.
 */
export const businessIntentSchema = z.enum([
  "GREETING",
  "THANKS",
  "PRODUCT_LIST",
  "PRODUCT_SEARCH",
  "STOCK_CHECK",
  "PRICE_CHECK",
  "QUOTE",
  // ORDER_REQUEST adalah aksi ADD_ITEM: menambahkan produk ke draft pesanan.
  "ORDER_REQUEST",
  "SET_ITEM_QUANTITY",
  "INCREMENT_ITEM",
  "DECREMENT_ITEM",
  "REMOVE_ITEM",
  "RESTORE_ITEM",
  "CLEAR_DRAFT",
  "ORDER_REVIEW",
  "ORDER_CONFIRMED",
  "PAYMENT_REPORTED",
  "PAYMENT_PROOF_SUBMITTED",
  "PACKAGING_INFO",
  "RETAIL_AVAILABILITY",
  "PAYMENT_INFO",
  "DELIVERY_CHECK",
  "DISCOUNT_REQUEST",
  "COMPLAINT",
  "HUMAN_HANDOFF",
  "CONFIRMATION",
  "UNKNOWN",
]);

export type BusinessIntent = z.infer<typeof businessIntentSchema>;

/**
 * Hasil ekstraksi bahasa natural. Tidak boleh memuat stok, harga, rekening,
 * atau fakta bisnis lain - hanya apa yang customer sebutkan.
 */
/**
 * Satu operasi semantik dari pesan customer. Satu pesan bisa memuat beberapa
 * operasi ("indomie 1 dus dan gula 2 kg" = dua ADD_ITEM), dan masing-masing
 * diselesaikan sendiri-sendiri oleh business engine.
 */
export const semanticOperationSchema = z.object({
  action: businessIntentSchema,
  product_query: z.string().max(120).nullable().default(null),
  catalog_product_name: z.string().max(120).nullable().default(null),
  /** Diisi context resolution saat operasi menyambung klarifikasi sebelumnya. */
  product_id: z.string().max(64).nullable().default(null),
  quantity: z.number().finite().nullable().default(null),
  unit: z.string().max(40).nullable().default(null),
});

export type SemanticOperation = z.infer<typeof semanticOperationSchema>;

export const structuredRequestSchema = z.object({
  intent: businessIntentSchema,
  /**
   * Operasi-operasi dalam pesan ini. Selalu berisi minimal satu setelah
   * normalisasi; operasi pertama mencerminkan field tingkat atas.
   */
  operations: z.array(semanticOperationSchema).max(8).default([]),
  /**
   * Pertanyaan tambahan dalam satu pesan ("1 dus isi berapa? bisa eceran?").
   * Intent utama tetap satu; sisanya dijawab sebagai pelengkap.
   */
  secondary_intents: z.array(businessIntentSchema).max(4).default([]),
  product_query: z.string().max(120).nullable().default(null),
  /**
   * Tebakan nama produk katalog untuk singkatan/typo ("indo grg" ->
   * "Indomie Goreng"). Hanya dipakai sebagai percobaan kedua kalau
   * product_query tidak bisa dicocokkan; ProductResolver tetap yang memutuskan.
   */
  catalog_product_name: z.string().max(120).nullable().default(null),
  quantity: z.number().finite().nullable().default(null),
  unit: z.string().max(40).nullable().default(null),
  urgency: z.boolean().default(false),
  tone: z.enum(["casual", "neutral", "formal"]).default("neutral"),
});

export type StructuredRequest = z.infer<typeof structuredRequestSchema>;

export type StructuredRequestSource = "gemini" | "deterministic" | "deterministic-after-gemini-error";

export type ProductResolutionStatus = "EXACT" | "FUZZY_SAFE" | "AMBIGUOUS" | "NOT_FOUND";

/**
 * Bentuk legacy yang tetap dikirim ke audit/tool result supaya konsumen lama
 * tetap bisa membaca hasil resolusi.
 */
export type ProductMatchType = "exact" | "fuzzy" | "ambiguous" | "none";

export type ProductMatchReason =
  | "exact_name"
  | "exact_sku"
  | "all_tokens_exact"
  | "typo_tolerated"
  | "partial_variant"
  | "variant_mismatch"
  | "size_mismatch"
  | "size_unverified"
  | "empty_query"
  | "context_reference";

export type SizeSpec = {
  dimension: "volume" | "mass";
  value: number;
};

export type ProductCandidate = {
  product: PublicProduct;
  confidence: number;
  reason: ProductMatchReason;
  matched_tokens: string[];
  unmatched_tokens: string[];
};

export type ProductResolution = {
  status: ProductResolutionStatus;
  match_type: ProductMatchType;
  requested_query: string;
  normalized_query: string;
  product: PublicProduct | null;
  candidates: ProductCandidate[];
  suggestions: ProductCandidate[];
  confidence: number;
  reason: string;
};

export type UnitResolutionStatus = "EXACT" | "CONVERTIBLE" | "NEEDS_CLARIFICATION";

export type UnitResolution = {
  status: UnitResolutionStatus;
  requested_unit: string | null;
  inventory_unit: string;
  unit_match: boolean;
  conversion: { factor: number; source: string } | null;
  /** Quantity customer setelah dikonversi ke satuan inventory, null jika belum bisa dipastikan. */
  quantity_in_inventory_unit: number | null;
  reason: string;
};

export type QuantityValidationStatus = "VALID" | "MISSING" | "INVALID_QUANTITY";

export type QuantityValidation = {
  status: QuantityValidationStatus;
  quantity: number | null;
  reason: string;
};

export type BusinessResultStatus =
  | "ORDER_PERSISTED"
  | "ORDER_CANCELLED"
  | "ORDER_CONFIRMATION_FAILED"
  | "GREETING_RESPONSE"
  | "THANKS_RESPONSE"
  | "PRODUCT_LISTED"
  | "PRODUCT_FOUND"
  | "PRODUCT_AMBIGUOUS"
  | "PRODUCT_NOT_FOUND"
  | "STOCK_AVAILABLE"
  | "OUT_OF_STOCK"
  | "PRICE_AVAILABLE"
  | "QUOTE_CREATED"
  | "READY_FOR_CONFIRMATION"
  | "INSUFFICIENT_STOCK"
  | "INVALID_QUANTITY"
  | "QUANTITY_REQUIRED"
  | "SELLABLE_UNIT_REQUIRED"
  | "UNIT_NOT_SELLABLE"
  | "NEEDS_CLARIFICATION"
  | "ITEM_ADDED"
  | "ITEM_UPDATED"
  | "ITEM_REMOVED"
  | "ITEM_RESTORED"
  | "DRAFT_CLEARED"
  | "DRAFT_EMPTY"
  | "DRAFT_ITEM_UNRESOLVED"
  | "ORDER_REVIEWED"
  | "ORDER_REVIEW_NEEDS_ADJUSTMENT"
  | "DRAFT_UPDATED"
  | "DRAFT_PARTIALLY_UPDATED"
  | "MULTI_PRODUCT_RESULT"
  | "PAYMENT_INSTRUCTIONS"
  | "PAYMENT_PROOF_REQUESTED"
  | "PAYMENT_PROOF_MISSING"
  | "PAYMENT_PROOF_RECEIVED"
  | "PAYMENT_VERIFICATION_REQUIRED"
  | "COMPLAINT_ESCALATED"
  | "PACKAGING_INFO_AVAILABLE"
  | "PACKAGING_DATA_UNAVAILABLE"
  | "RETAIL_AVAILABILITY_UNKNOWN"
  | "PAYMENT_ACCOUNTS"
  | "DELIVERY_UNAVAILABLE"
  | "DISCOUNT_NOT_AVAILABLE"
  | "HANDOFF_CREATED"
  | "DATA_UNAVAILABLE"
  | "NO_BUSINESS_REQUEST";

/**
 * Satu baris draft pesanan setelah divalidasi ulang ke database. Harga, stok,
 * dan subtotal di sini selalu hasil pembacaan terbaru - tidak pernah angka yang
 * diingat dari turn sebelumnya.
 */
export type DraftReviewItem = {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  inventory_unit: string;
  unit_price: number | null;
  subtotal: number | null;
  stock_quantity: number | null;
  stock_sufficient: boolean;
  shortfall: number | null;
  issue: "NONE" | "INSUFFICIENT_STOCK" | "PRODUCT_INACTIVE" | "UNIT_UNCLEAR";
};

export type DraftReview = {
  items: DraftReviewItem[];
  cancelled_items: Array<{ product_id: string; product_name: string }>;
  grand_total: number | null;
  all_available: boolean;
};

/** Hasil satu operasi semantik. Operasi yang gagal tidak menjatuhkan yang lain. */
export type OperationResultStatus =
  | "APPLIED"
  | "NEEDS_UNIT_CLARIFICATION"
  | "SELLABLE_UNIT_REQUIRED"
  | "UNIT_NOT_SELLABLE"
  | "QUANTITY_REQUIRED"
  | "INVALID_QUANTITY"
  | "INSUFFICIENT_STOCK"
  | "PRODUCT_AMBIGUOUS"
  | "PRODUCT_NOT_FOUND"
  | "NOT_IN_DRAFT";

export type OperationResult = {
  action: BusinessIntent;
  status: OperationResultStatus;
  requested_query: string | null;
  requested_quantity: number | null;
  requested_unit: string | null;
  product_id: string | null;
  product_name: string | null;
  /** Jumlah dan satuan yang benar-benar tercatat, bila operasinya berhasil. */
  applied_quantity: number | null;
  applied_unit: string | null;
  catalog_unit: string | null;
  stock_quantity: number | null;
  price: number | null;
  total: number | null;
  stock_sufficient: boolean | null;
  candidates: string[];
  reason: string;
};

/** Ringkasan draft berjalan: hanya identitas dan jumlah, tanpa angka uang. */
export type RunningDraft = {
  items: Array<{ product_id: string; product_name: string; quantity: number; unit: string }>;
  cancelled: Array<{ product_id: string; product_name: string }>;
};

/** Isi kemasan resmi (mis. 1 dus = 40 bungkus) dari data konversi satuan. */
export type PackagingFact = {
  outer_unit: string;
  inner_unit: string;
  quantity_per_outer: number;
  source: string;
};

/**
 * Jawaban untuk pertanyaan tambahan dalam pesan yang sama. Bentuknya sengaja
 * sempit: tidak boleh membawa angka bisnis selain yang sudah diverifikasi.
 */
export type SupplementaryResult = {
  intent: BusinessIntent;
  status: BusinessResultStatus;
  reason: string;
  packaging: PackagingFact | null;
  payment_accounts: PublicPaymentAccount[];
};

/**
 * Satu-satunya sumber fakta yang boleh dipakai untuk menyusun jawaban customer.
 * Semua angka di sini berasal dari database melalui business tools.
 */
export type BusinessResult = {
  checkout?: Checkout;
  persisted_order?: OrderDetail;
  intent: BusinessIntent;
  status: BusinessResultStatus;
  product: PublicProduct | null;
  product_resolution: ProductResolution | null;
  unit_resolution: UnitResolution | null;
  requested: {
    product_query: string | null;
    quantity: number | null;
    unit: string | null;
  };
  availability: { quantity: number; unit: string } | null;
  price: number | null;
  total: number | null;
  maximum_available: number | null;
  shortfall: number | null;
  stock_sufficient: boolean | null;
  unit_match: boolean | null;
  order_allowed: boolean;
  candidates: PublicProduct[];
  suggestions: PublicProduct[];
  listed_products: PublicListedProduct[];
  pagination: { limit: number; offset: number; has_more: boolean } | null;
  payment_accounts: PublicPaymentAccount[];
  sellable_units: PublicProductUnit[];
  selected_unit: PublicProductUnit | null;
  packaging: PackagingFact | null;
  /** Ringkasan draft pesanan; hanya terisi saat draft memang dibaca/divalidasi. */
  draft: DraftReview | null;
  /** Daftar barang aktif setelah mutasi, untuk jawaban "jadi sementara ...". */
  running_draft: RunningDraft | null;
  /** Hasil tiap operasi semantik dalam pesan ini. */
  operation_results: OperationResult[];
  /** Operasi yang masih menunggu jawaban customer (mis. satuan belum jelas). */
  pending_clarification: {
    product_id: string;
    product_name: string;
    catalog_unit: string;
    requested_quantity: number | null;
    requested_unit: string | null;
  } | null;
  /** Baris draft yang barusan berubah, untuk jawaban "sudah saya catat". */
  draft_change: {
    action: BusinessIntent;
    product_name: string;
    quantity: number;
    unit: string;
    active_item_count: number;
  } | null;
  /** Hasil untuk secondary_intents pada pesan yang sama. */
  supplementary: SupplementaryResult[];
  /** Handoff nyata yang sudah tersimpan, bila percakapan ini perlu manusia. */
  handoff: {
    required: boolean;
    reason_code: string | null;
    handoff_id: string | null;
    status: string | null;
  };
  urgency: boolean;
  reason: string;
};

export type OrderValidation = {
  product_id: string;
  product_name: string;
  requested_quantity: number | null;
  requested_unit: string | null;
  stock_quantity: number;
  stock_unit: string;
  unit_match: boolean;
  sellable_unit: string | null;
  unit_sellable: boolean;
  sufficient_stock: boolean;
  maximum_available: number;
  order_allowed: boolean;
  reason: string;
};

/** Intent yang tidak bisa dijawab tanpa identitas produk. */
export const PRODUCT_REQUIRED_INTENTS: BusinessIntent[] = [
  "PRODUCT_SEARCH",
  "STOCK_CHECK",
  "PRICE_CHECK",
  "QUOTE",
  "PACKAGING_INFO",
  "RETAIL_AVAILABILITY",
];

export function requiresProduct(intent: BusinessIntent) {
  return PRODUCT_REQUIRED_INTENTS.includes(intent);
}

/**
 * Aksi yang mengubah draft pesanan. ORDER_REQUEST adalah ADD_ITEM. Semuanya
 * dijalankan deterministik oleh business engine; model bahasa hanya boleh
 * mengusulkan aksinya, tidak pernah mengubah draft sendiri.
 */
export const DRAFT_MUTATION_INTENTS: BusinessIntent[] = [
  "ORDER_REQUEST",
  "SET_ITEM_QUANTITY",
  "INCREMENT_ITEM",
  "DECREMENT_ITEM",
  "REMOVE_ITEM",
  "RESTORE_ITEM",
  "CLEAR_DRAFT",
];

export function mutatesDraft(intent: BusinessIntent) {
  return DRAFT_MUTATION_INTENTS.includes(intent);
}

/**
 * Menjamin structured request selalu punya minimal satu operasi, dan field
 * tingkat atas selalu mencerminkan operasi pertama. Dengan begini kode lama
 * yang membaca `intent`/`product_query`/`quantity` tetap bekerja.
 */
export function normalizeOperations(request: StructuredRequest): StructuredRequest {
  const operations =
    request.operations.length > 0
      ? request.operations
      : [
          {
            action: request.intent,
            product_query: request.product_query,
            catalog_product_name: request.catalog_product_name,
            product_id: null,
            quantity: request.quantity,
            unit: request.unit,
          },
        ];

  const first = operations[0];

  return {
    ...request,
    operations,
    intent: first.action,
    product_query: first.product_query,
    catalog_product_name: first.catalog_product_name,
    quantity: first.quantity,
    unit: first.unit,
  };
}
