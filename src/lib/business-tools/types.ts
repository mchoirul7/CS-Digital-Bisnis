export type Company = {
  id: string;
  name: string;
  created_at: string;
};

export type Product = {
  id: string;
  company_id: string;
  sku: string;
  name: string;
  description: string | null;
  unit: string;
  price: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type InventoryItem = {
  id: string;
  company_id: string;
  product_id: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  updated_at: string;
};

export type PaymentAccount = {
  id: string;
  company_id: string;
  bank_name: string;
  account_number: string;
  account_name: string;
  active: boolean;
  created_at: string;
};

export type ProductUnit = {
  id: string;
  company_id: string;
  product_id: string;
  unit_code: string;
  is_sellable: boolean;
  is_base_unit: boolean;
  conversion_to_base: number;
  selling_price: number | null;
  min_quantity: number;
  quantity_step: number;
  created_at: string;
  updated_at: string;
};

/**
 * Konversi satuan resmi (mis. 1 dus = 40 bungkus). Belum ada tabelnya di
 * Supabase, jadi repository mengembalikan array kosong dan unit resolver akan
 * meminta klarifikasi. Interface-nya sudah siap ketika tabelnya ditambahkan.
 */
export type UnitConversion = {
  id: string;
  company_id: string;
  product_id: string | null;
  from_unit: string;
  to_unit: string;
  factor: number;
  created_at?: string;
};

/**
 * Siapa yang sedang memegang percakapan. AI hanya boleh menjawab pada
 * AI_ACTIVE; selebihnya pesan customer tetap disimpan tanpa jawaban AI.
 */
export type ConversationOwnership = "AI_ACTIVE" | "HUMAN_PENDING" | "HUMAN_ACTIVE" | "CLOSED";

export type Conversation = {
  id: string;
  company_id: string;
  session_id: string;
  state: unknown;
  state_version?: number;
  ownership: ConversationOwnership;
  created_at: string;
  updated_at: string;
};

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type MessageSender = "CUSTOMER" | "AI" | "ADMIN" | "SYSTEM";

export type Message = {
  id: string;
  conversation_id: string;
  role: MessageRole;
  sender: MessageSender;
  content: string;
  created_at: string;
};

/** Alasan terstruktur kenapa percakapan perlu manusia. */
export type HandoffReasonCode =
  | "AI_UNCERTAIN"
  | "CUSTOMER_REQUESTED_HUMAN"
  | "PRODUCT_AMBIGUOUS_UNRESOLVED"
  | "SPECIAL_PRICE_REQUEST"
  | "DISCOUNT_REQUEST"
  | "DELIVERY_UNVERIFIED"
  | "PAYMENT_ISSUE"
  | "PAYMENT_VERIFICATION"
  | "COMPLAINT"
  | "ORDER_EXCEPTION"
  | "BUSINESS_DATA_UNAVAILABLE"
  | "UNSAFE_RESPONSE_BLOCKED"
  | "OUT_OF_SCOPE"
  | "OTHER";

export type HandoffStatus = "PENDING" | "ACTIVE" | "RESOLVED" | "CLOSED";

export type HumanHandoff = {
  id: string;
  conversation_id: string;
  reason: string;
  reason_code: HandoffReasonCode;
  summary: string;
  metadata: Record<string, unknown>;
  status: HandoffStatus;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
};

export type HandoffInput = {
  conversationId: string;
  reason: string;
  reasonCode: HandoffReasonCode;
  summary: string;
  metadata: Record<string, unknown>;
};

export type PublicProduct = Pick<Product, "id" | "sku" | "name" | "description" | "unit">;

export type PublicListedProduct = PublicProduct & Pick<Product, "price">;

export type PublicProductUnit = Pick<
  ProductUnit,
  | "product_id"
  | "unit_code"
  | "is_sellable"
  | "is_base_unit"
  | "conversion_to_base"
  | "selling_price"
  | "min_quantity"
  | "quantity_step"
>;

export type PublicPaymentAccount = Pick<
  PaymentAccount,
  "id" | "bank_name" | "account_number" | "account_name"
>;

export interface BusinessRepository {
  getCompany(companyId: string): Promise<Company | null>;
  listProducts(companyId: string): Promise<Product[]>;
  listActiveProducts(companyId: string, limit: number, offset: number): Promise<Product[]>;
  getProduct(companyId: string, productId: string): Promise<Product | null>;
  getInventory(companyId: string, productId: string): Promise<InventoryItem | null>;
  listProductUnits(companyId: string, productId: string): Promise<ProductUnit[]>;
  listUnitConversions(companyId: string, productId: string): Promise<UnitConversion[]>;
  listPaymentAccounts(companyId: string): Promise<PaymentAccount[]>;
  upsertConversation(companyId: string, sessionId: string): Promise<Conversation>;
  resetConversationSession(companyId: string, sessionId: string): Promise<Conversation>;
  getConversation(companyId: string, conversationId: string): Promise<Conversation | null>;
  listConversationsByOwnership(
    companyId: string,
    ownerships: ConversationOwnership[],
  ): Promise<Conversation[]>;
  saveConversationState(conversationId: string, state: unknown, expectedVersion?: number): Promise<void>;
  confirmOrder(input: ConfirmOrderInput): Promise<OrderDetail>;
  getOrder(companyId: string, orderId: string): Promise<OrderDetail | null>;
  listOrders(companyId: string, status?: OrderStatus, offset?: number): Promise<Order[]>;
  changeOrderStatus(companyId: string, orderId: string, status: OrderStatus): Promise<OrderDetail>;
  recordBusinessAudit(input: BusinessAuditInput): Promise<void>;
  setConversationOwnership(conversationId: string, ownership: ConversationOwnership): Promise<void>;
  addMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    sender: MessageSender,
  ): Promise<Message>;
  listMessages(conversationId: string, limit: number): Promise<Message[]>;
  /** Handoff yang belum selesai (PENDING atau ACTIVE) untuk satu percakapan. */
  findOpenHandoff(conversationId: string): Promise<HumanHandoff | null>;
  createHandoff(input: HandoffInput): Promise<HumanHandoff>;
  /** Klaim atomik: hanya berhasil bila handoff masih PENDING. */
  claimHandoff(handoffId: string): Promise<HumanHandoff | null>;
  closeHandoff(handoffId: string, status: "RESOLVED" | "CLOSED"): Promise<HumanHandoff | null>;
  listHandoffs(companyId: string, statuses: HandoffStatus[]): Promise<HumanHandoff[]>;
  getHandoff(handoffId: string): Promise<HumanHandoff | null>;
}

export type BusinessToolName =
  | "create_order"
  | "confirm_order"
  | "cancel_order"
  | "get_order"
  | "list_orders"
  | "list_active_products"
  | "search_products"
  | "get_product"
  | "get_stock"
  | "get_price"
  | "list_product_units"
  | "validate_order"
  | "calculate_order"
  | "list_unit_conversions"
  | "get_payment_accounts"
  | "get_delivery_information"
  | "request_human_handoff";

export type BusinessToolExecution = {
  success?: boolean;
  error?: string;
  tool_name: BusinessToolName;
  arguments: Record<string, unknown>;
  database_result: unknown;
  timestamp: string;
};
import type { BusinessAuditInput, ConfirmOrderInput, Order, OrderDetail, OrderStatus } from "./order-types";
