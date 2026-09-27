import type { BusinessGuardResult } from "@/lib/business-guard";
import type {
  BusinessIntent,
  BusinessResult,
  ProductResolution,
  StructuredRequest,
  StructuredRequestSource,
  UnitResolution,
} from "@/lib/business/types";
import type {
  BusinessToolExecution,
  ConversationOwnership,
  MessageSender,
} from "@/lib/business-tools/types";
import type { ActiveProduct, ConversationState, ProductSource } from "./conversation-state";

export type ChatRole = "user" | "assistant";

export type ChatHistoryMessage = {
  role: ChatRole;
  content: string;
  sender?: MessageSender;
};

export type ResponseSource = "gemini" | "deterministic" | "deterministic-after-gemini-error";

/**
 * Ringkasan datar untuk panel debug: satu baris per fakta penting yang dipakai
 * saat menyusun jawaban.
 */
export type ChatAudit = {
  intent: BusinessIntent;
  secondary_intents: BusinessIntent[];
  requested_product: string | null;
  resolved_product: string | null;
  product_source: ProductSource;
  product_match_status: ProductResolution["status"] | null;
  product_match_confidence: number | null;
  product_match_reason: string | null;
  requested_quantity: number | null;
  requested_unit: string | null;
  database_unit: string | null;
  current_stock: number | null;
  unit_match: boolean | null;
  sufficient_stock: boolean | null;
  order_allowed: boolean;
  price: number | null;
  total: number | null;
  packaging_per_outer: number | null;
  listed_product_count: number;
  status: BusinessResult["status"];
  reason: string;
};

export type ContextResolutionAudit = {
  product_source: ProductSource;
  active_product_before: ActiveProduct | null;
  active_product_after: ActiveProduct | null;
  inherited_intent: boolean;
  inherited_quantity: boolean;
  inherited_unit: boolean;
  scoped_to_pending_candidates: boolean;
  notes: string[];
};

export type HandoffAudit = {
  triggered: boolean;
  reason_code: string | null;
  business_reason: string;
  handoff_id: string | null;
  status: string | null;
};

export type ChatDebug = {
  rawMessage: string;
  structuredRequest: StructuredRequest;
  effectiveRequest: StructuredRequest;
  intentSource: StructuredRequestSource;
  /** Nilai dari Gemini yang ditolak karena tidak terbukti ada di pesan customer. */
  groundingRejections: string[];
  conversationStateBefore: ConversationState;
  conversationStateAfter: ConversationState;
  contextResolution: ContextResolutionAudit;
  productResolution: ProductResolution | null;
  unitResolution: UnitResolution | null;
  toolCalls: BusinessToolExecution[];
  businessResult: BusinessResult;
  audit: ChatAudit;
  handoff: HandoffAudit;
  ownershipBefore: ConversationOwnership;
  ownershipAfter: ConversationOwnership;
  aiResponseAllowed: boolean;
  aiCandidateResponse: string;
  responseSource: ResponseSource;
  businessGuard: BusinessGuardResult;
  finalResponse: string;
  geminiError?: string;
};

export type ChatServiceInput = {
  customerPhone?: string | null;
  message: string;
  sessionId: string;
  attachments?: Array<{ name: string; mime_type: string; size: number }>;
  /** Dipakai hanya kalau percakapan belum punya state tersimpan. */
  initialState?: ConversationState;
};

export type ChatServiceOutput = {
  /** null berarti AI sengaja diam karena percakapan sedang dipegang admin. */
  reply: string | null;
  conversationId: string;
  ownership: ConversationOwnership;
  state: ConversationState;
  debug: ChatDebug | null;
};
