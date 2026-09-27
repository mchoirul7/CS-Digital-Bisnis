import type {
  Company,
  Conversation,
  HumanHandoff,
  InventoryItem,
  Message,
  PaymentAccount,
  Product,
  ProductUnit,
  UnitConversion,
} from "@/lib/business-tools/types";
import type { Customer, Order, OrderItem } from "@/lib/business-tools/order-types";

type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] };
type AuditRow = { id: string; company_id: string; conversation_id: string; created_at: string };

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      customers: Table<Customer>;
      orders: Table<Order>;
      order_items: Table<OrderItem>;
      tool_calls: Table<AuditRow & { tool_name: string; arguments: Json; result: Json; success: boolean; error_message: string | null }>;
      business_guard_logs: Table<AuditRow & { guard_type: string; action: string; reason: string; metadata: Json }>;
      companies: {
        Row: Company;
        Insert: Partial<Company> & Pick<Company, "name">;
        Update: Partial<Company>;
        Relationships: [];
      };
      products: {
        Row: Product;
        Insert: Partial<Product> &
          Pick<Product, "company_id" | "sku" | "name" | "unit" | "price">;
        Update: Partial<Product>;
        Relationships: [];
      };
      inventory: {
        Row: InventoryItem;
        Insert: Partial<InventoryItem> & Pick<InventoryItem, "company_id" | "product_id" | "quantity_on_hand">;
        Update: Partial<InventoryItem>;
        Relationships: [];
      };
      product_units: {
        Row: ProductUnit;
        Insert: Partial<ProductUnit> &
          Pick<
            ProductUnit,
            "company_id" | "product_id" | "unit_code" | "is_sellable" | "conversion_to_base"
          >;
        Update: Partial<ProductUnit>;
        Relationships: [];
      };
      unit_conversions: {
        Row: UnitConversion;
        Insert: Partial<UnitConversion> &
          Pick<UnitConversion, "company_id" | "from_unit" | "to_unit" | "factor">;
        Update: Partial<UnitConversion>;
        Relationships: [];
      };
      payment_accounts: {
        Row: PaymentAccount;
        Insert: Partial<PaymentAccount> &
          Pick<PaymentAccount, "company_id" | "bank_name" | "account_number" | "account_name">;
        Update: Partial<PaymentAccount>;
        Relationships: [];
      };
      conversations: {
        Row: Conversation;
        Insert: Partial<Conversation> & Pick<Conversation, "company_id" | "session_id">;
        Update: Partial<Conversation>;
        Relationships: [];
      };
      messages: {
        Row: Message;
        Insert: Partial<Message> & Pick<Message, "conversation_id" | "role" | "content">;
        Update: Partial<Message>;
        Relationships: [];
      };
      human_handoffs: {
        Row: HumanHandoff;
        Insert: Partial<HumanHandoff> & Pick<HumanHandoff, "conversation_id" | "reason">;
        Update: Partial<HumanHandoff>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      confirm_order: { Args: { p_company_id: string; p_conversation_id: string; p_checkout_key: string; p_phone?: string | null }; Returns: string };
      change_order_status: { Args: { p_company_id: string; p_order_id: string; p_status: string }; Returns: string };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
