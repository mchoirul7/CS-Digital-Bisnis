export type OrderStatus = "draft" | "confirmed" | "processing" | "completed" | "cancelled";

export type Customer = {
  id: string; company_id: string; name: string | null; phone: string | null;
  customer_code: string | null; active: boolean; created_at: string; updated_at: string;
};

export type Order = {
  id: string; company_id: string; customer_id: string | null; conversation_id: string | null;
  checkout_key: string; order_number: string; status: OrderStatus;
  subtotal: number; discount: number; total: number; notes: string | null;
  created_at: string; updated_at: string; confirmed_at: string | null; cancelled_at: string | null;
};

export type OrderItem = {
  id: string; company_id: string; order_id: string; product_id: string; product_name: string;
  quantity: number; unit: string; unit_price: number; subtotal: number;
  conversion_to_base: number; base_quantity: number; created_at: string; updated_at: string;
};

export type OrderDetail = Order & { items: OrderItem[]; customer: Customer | null };

export type Checkout = {
  key: string;
  items: Array<{ product_id: string; quantity: number; unit: string; unit_price: number; conversion_to_base: number }>;
};

export type ConfirmOrderInput = {
  companyId: string; conversationId: string; checkoutKey: string; phone?: string | null;
};

export type BusinessAuditInput = {
  companyId: string; conversationId: string;
  toolCalls: import("./types").BusinessToolExecution[];
  guards: Array<{ type: string; action: "allowed" | "blocked"; reason: string }>;
};
