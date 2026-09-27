import { getSupabaseServerClient } from "@/lib/supabase/client";
import type { Json } from "@/lib/supabase/types";
import type { BusinessAuditInput, ConfirmOrderInput, Order, OrderDetail, OrderStatus } from "./order-types";
import type {
  BusinessRepository,
  Company,
  Conversation,
  ConversationOwnership,
  HandoffInput,
  HandoffStatus,
  HumanHandoff,
  InventoryItem,
  Message,
  MessageRole,
  MessageSender,
  PaymentAccount,
  Product,
  ProductUnit,
  UnitConversion,
} from "./types";

function assertNoError(error: { message: string } | null, operation: string) {
  if (error) {
    throw new Error(`${operation}: ${error.message}`);
  }
}

/** Tabel opsional yang belum ada di database: PostgREST 205, PostgreSQL 42P01. */
function isMissingTable(error: { code?: string } | null) {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

/** Pelanggaran unique index "satu handoff terbuka per percakapan". */
function isUniqueViolation(error: { code?: string } | null) {
  return error?.code === "23505";
}

export class SupabaseBusinessRepository implements BusinessRepository {
  private readonly supabase = getSupabaseServerClient();

  async confirmOrder(input: ConfirmOrderInput): Promise<OrderDetail> {
    const { data, error } = await this.supabase.rpc("confirm_order", {
      p_company_id: input.companyId, p_conversation_id: input.conversationId,
      p_checkout_key: input.checkoutKey, p_phone: input.phone ?? null,
    });
    assertNoError(error, "confirmOrder");
    const order = data ? await this.getOrder(input.companyId, data) : null;
    if (!order) throw new Error("ORDER_NOT_FOUND");
    return order;
  }

  async getOrder(companyId: string, orderId: string): Promise<OrderDetail | null> {
    const { data: order, error } = await this.supabase.from("orders").select("*")
      .eq("company_id", companyId).eq("id", orderId).maybeSingle();
    assertNoError(error, "getOrder");
    if (!order) return null;
    const { data: items, error: itemsError } = await this.supabase.from("order_items").select("*")
      .eq("company_id", companyId).eq("order_id", orderId).order("created_at");
    assertNoError(itemsError, "getOrderItems");
    const customer = order.customer_id
      ? await this.supabase.from("customers").select("*").eq("company_id", companyId).eq("id", order.customer_id).maybeSingle()
      : { data: null, error: null };
    assertNoError(customer.error, "getCustomer");
    return { ...order, items: items ?? [], customer: customer.data };
  }

  async listOrders(companyId: string, status?: OrderStatus, offset = 0): Promise<Order[]> {
    let query = this.supabase.from("orders").select("*").eq("company_id", companyId);
    if (status) query = query.eq("status", status);
    const { data, error } = await query.order("created_at", { ascending: false }).order("id").range(offset, offset + 49);
    assertNoError(error, "listOrders");
    return data ?? [];
  }

  async changeOrderStatus(companyId: string, orderId: string, status: OrderStatus): Promise<OrderDetail> {
    const { error } = await this.supabase.rpc("change_order_status", {
      p_company_id: companyId, p_order_id: orderId, p_status: status,
    });
    assertNoError(error, "changeOrderStatus");
    const order = await this.getOrder(companyId, orderId);
    if (!order) throw new Error("ORDER_NOT_FOUND");
    return order;
  }

  async recordBusinessAudit(input: BusinessAuditInput): Promise<void> {
    if (input.toolCalls.length) {
      const { error } = await this.supabase.from("tool_calls").insert(input.toolCalls.map((call) => ({
        company_id: input.companyId, conversation_id: input.conversationId, tool_name: call.tool_name,
        arguments: call.arguments as Json, result: call.database_result as Json, success: call.success ?? true,
        error_message: call.error ?? null,
      })));
      assertNoError(error, "recordToolCalls");
    }
    if (input.guards.length) {
      const { error } = await this.supabase.from("business_guard_logs").insert(input.guards.map((guard) => ({
        company_id: input.companyId, conversation_id: input.conversationId,
        guard_type: guard.type, action: guard.action, reason: guard.reason, metadata: {},
      })));
      assertNoError(error, "recordBusinessGuards");
    }
  }

  async getCompany(companyId: string): Promise<Company | null> {
    const { data, error } = await this.supabase
      .from("companies")
      .select("*")
      .eq("id", companyId)
      .maybeSingle();

    assertNoError(error, "getCompany");
    return data;
  }

  async listProducts(companyId: string): Promise<Product[]> {
    const { data, error } = await this.supabase
      .from("products")
      .select("*")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name", { ascending: true });

    assertNoError(error, "listProducts");
    return data ?? [];
  }

  async listActiveProducts(companyId: string, limit: number, offset: number): Promise<Product[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    const { data, error } = await this.supabase
      .from("products")
      .select("*")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("name", { ascending: true })
      .range(safeOffset, safeOffset + safeLimit - 1);

    assertNoError(error, "listActiveProducts");
    return data ?? [];
  }

  async getProduct(companyId: string, productId: string): Promise<Product | null> {
    const { data, error } = await this.supabase
      .from("products")
      .select("*")
      .eq("company_id", companyId)
      .eq("id", productId)
      .eq("active", true)
      .maybeSingle();

    assertNoError(error, "getProduct");
    return data;
  }

  async getInventory(companyId: string, productId: string): Promise<InventoryItem | null> {
    const { data, error } = await this.supabase
      .from("inventory")
      .select("*")
      .eq("company_id", companyId)
      .eq("product_id", productId)
      .maybeSingle();

    assertNoError(error, "getInventory");
    return data;
  }

  async listProductUnits(companyId: string, productId: string): Promise<ProductUnit[]> {
    const { data, error } = await this.supabase
      .from("product_units")
      .select("*")
      .eq("company_id", companyId)
      .eq("product_id", productId)
      .order("is_base_unit", { ascending: false })
      .order("unit_code", { ascending: true });

    assertNoError(error, "listProductUnits");
    return data ?? [];
  }

  async listUnitConversions(companyId: string, productId: string): Promise<UnitConversion[]> {
    const { data: productRows, error: productError } = await this.supabase
      .from("unit_conversions")
      .select("*")
      .eq("company_id", companyId)
      .eq("product_id", productId);

    if (isMissingTable(productError)) return [];
    assertNoError(productError, "listUnitConversions.product");

    const { data: globalRows, error: globalError } = await this.supabase
      .from("unit_conversions")
      .select("*")
      .eq("company_id", companyId)
      .is("product_id", null);

    if (isMissingTable(globalError)) return productRows ?? [];
    assertNoError(globalError, "listUnitConversions.global");

    return [...(productRows ?? []), ...(globalRows ?? [])];
  }

  async listPaymentAccounts(companyId: string): Promise<PaymentAccount[]> {
    const { data, error } = await this.supabase
      .from("payment_accounts")
      .select("*")
      .eq("company_id", companyId)
      .eq("active", true)
      .order("created_at", { ascending: true });

    assertNoError(error, "listPaymentAccounts");
    return data ?? [];
  }

  async upsertConversation(companyId: string, sessionId: string): Promise<Conversation> {
    const { data: existing, error: readError } = await this.supabase
      .from("conversations")
      .select("*")
      .eq("company_id", companyId)
      .eq("session_id", sessionId)
      .maybeSingle();

    assertNoError(readError, "readConversation");

    if (existing) {
      return existing;
    }

    const { data, error } = await this.supabase
      .from("conversations")
      .insert({ company_id: companyId, session_id: sessionId })
      .select("*")
      .single();

    assertNoError(error, "createConversation");
    if (!data) {
      throw new Error("createConversation: no conversation returned");
    }
    return data;
  }

  async resetConversationSession(companyId: string, sessionId: string): Promise<Conversation> {
    const conversation = await this.upsertConversation(companyId, sessionId);
    const now = new Date().toISOString();

    const { error: messageError } = await this.supabase
      .from("messages")
      .delete()
      .eq("conversation_id", conversation.id);

    assertNoError(messageError, "resetConversationSession.deleteMessages");

    const { error: handoffError } = await this.supabase
      .from("human_handoffs")
      .update({ status: "CLOSED", resolved_at: now })
      .eq("conversation_id", conversation.id)
      .in("status", ["PENDING", "ACTIVE"]);

    assertNoError(handoffError, "resetConversationSession.closeHandoffs");

    const { data, error } = await this.supabase
      .from("conversations")
      .update({ state: {}, ownership: "AI_ACTIVE", updated_at: now })
      .eq("company_id", companyId)
      .eq("id", conversation.id)
      .select("*")
      .single();

    assertNoError(error, "resetConversationSession.updateConversation");
    if (!data) {
      throw new Error("resetConversationSession: no conversation returned");
    }

    return data;
  }

  async getConversation(companyId: string, conversationId: string): Promise<Conversation | null> {
    const { data, error } = await this.supabase
      .from("conversations")
      .select("*")
      .eq("company_id", companyId)
      .eq("id", conversationId)
      .maybeSingle();

    assertNoError(error, "getConversation");
    return data;
  }

  async listConversationsByOwnership(
    companyId: string,
    ownerships: ConversationOwnership[],
  ): Promise<Conversation[]> {
    const { data, error } = await this.supabase
      .from("conversations")
      .select("*")
      .eq("company_id", companyId)
      .in("ownership", ownerships)
      .order("updated_at", { ascending: false })
      .limit(100);

    assertNoError(error, "listConversationsByOwnership");
    return data ?? [];
  }

  async saveConversationState(conversationId: string, state: unknown, expectedVersion?: number): Promise<void> {
    let query = this.supabase
      .from("conversations")
      .update({ state, state_version: (expectedVersion ?? 0) + 1, updated_at: new Date().toISOString() })
      .eq("id", conversationId);
    if (expectedVersion !== undefined) query = query.eq("state_version", expectedVersion);
    const { data, error } = await query.select("id").maybeSingle();
    assertNoError(error, "saveConversationState");
    if (!data) throw new Error("CONVERSATION_CHANGED");
  }

  async setConversationOwnership(
    conversationId: string,
    ownership: ConversationOwnership,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("conversations")
      .update({ ownership, updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    assertNoError(error, "setConversationOwnership");
  }

  async addMessage(
    conversationId: string,
    role: MessageRole,
    content: string,
    sender: MessageSender,
  ): Promise<Message> {
    const { data, error } = await this.supabase
      .from("messages")
      .insert({ conversation_id: conversationId, role, content, sender })
      .select("*")
      .single();

    assertNoError(error, "addMessage");
    if (!data) {
      throw new Error("addMessage: no message returned");
    }
    return data;
  }

  async listMessages(conversationId: string, limit: number): Promise<Message[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const { data, error } = await this.supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(safeLimit);

    assertNoError(error, "listMessages");
    return (data ?? []).slice().reverse();
  }

  async findOpenHandoff(conversationId: string): Promise<HumanHandoff | null> {
    const { data, error } = await this.supabase
      .from("human_handoffs")
      .select("*")
      .eq("conversation_id", conversationId)
      .in("status", ["PENDING", "ACTIVE"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    assertNoError(error, "findOpenHandoff");
    return data;
  }

  /**
   * Idempotent: kalau percakapan sudah punya handoff terbuka, handoff itu yang
   * dipakai. Unique index di database menjadi penjaga terakhir saat dua request
   * mencoba membuat handoff bersamaan.
   */
  async createHandoff(input: HandoffInput): Promise<HumanHandoff> {
    const existing = await this.findOpenHandoff(input.conversationId);
    if (existing) {
      return existing;
    }

    const { data, error } = await this.supabase
      .from("human_handoffs")
      .insert({
        conversation_id: input.conversationId,
        reason: input.reason,
        reason_code: input.reasonCode,
        summary: input.summary,
        metadata: input.metadata,
        status: "PENDING",
      })
      .select("*")
      .single();

    if (isUniqueViolation(error as { code?: string } | null)) {
      const concurrent = await this.findOpenHandoff(input.conversationId);
      if (concurrent) {
        return concurrent;
      }
    }

    assertNoError(error, "createHandoff");
    if (!data) {
      throw new Error("createHandoff: no handoff returned");
    }
    return data;
  }

  async claimHandoff(handoffId: string): Promise<HumanHandoff | null> {
    const { data, error } = await this.supabase
      .from("human_handoffs")
      .update({ status: "ACTIVE", claimed_at: new Date().toISOString() })
      .eq("id", handoffId)
      .eq("status", "PENDING")
      .select("*")
      .maybeSingle();

    assertNoError(error, "claimHandoff");
    return data;
  }

  async closeHandoff(handoffId: string, status: "RESOLVED" | "CLOSED"): Promise<HumanHandoff | null> {
    const { data, error } = await this.supabase
      .from("human_handoffs")
      .update({ status, resolved_at: new Date().toISOString() })
      .eq("id", handoffId)
      .in("status", ["PENDING", "ACTIVE"])
      .select("*")
      .maybeSingle();

    assertNoError(error, "closeHandoff");
    return data;
  }

  async listHandoffs(companyId: string, statuses: HandoffStatus[]): Promise<HumanHandoff[]> {
    const { data: conversations, error: conversationError } = await this.supabase
      .from("conversations")
      .select("id")
      .eq("company_id", companyId);

    assertNoError(conversationError, "listHandoffs.conversations");

    const ids = (conversations ?? []).map((row: { id: string }) => row.id);
    if (ids.length === 0) {
      return [];
    }

    const { data, error } = await this.supabase
      .from("human_handoffs")
      .select("*")
      .in("conversation_id", ids)
      .in("status", statuses)
      .order("created_at", { ascending: false })
      .limit(100);

    assertNoError(error, "listHandoffs");
    return data ?? [];
  }

  async getHandoff(handoffId: string): Promise<HumanHandoff | null> {
    const { data, error } = await this.supabase
      .from("human_handoffs")
      .select("*")
      .eq("id", handoffId)
      .maybeSingle();

    assertNoError(error, "getHandoff");
    return data;
  }
}
