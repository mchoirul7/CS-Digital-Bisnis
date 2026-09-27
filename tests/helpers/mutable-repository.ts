import type {
  BusinessRepository,
  Company,
  Conversation,
  HumanHandoff,
  InventoryItem,
  Message,
  MessageRole,
  MessageSender,
  PaymentAccount,
  Product,
  ProductUnit,
  UnitConversion,
} from "@/lib/business-tools/types";
import { DEFAULT_COMPANY_ID } from "@/lib/company";

export const testCompany: Company = {
  id: DEFAULT_COMPANY_ID,
  name: "CV Maju Lancar",
  created_at: "2026-09-12T00:00:00.000Z",
};

export type ProductSeed = {
  id: string;
  sku: string;
  name: string;
  description?: string | null;
  unit: string;
  price: number;
  quantity: number;
  active?: boolean;
  productUnits?: Array<{
    unit_code: string;
    is_sellable: boolean;
    is_base_unit?: boolean;
    conversion_to_base: number;
    selling_price?: number | null;
    min_quantity?: number;
    quantity_step?: number;
  }>;
};

export const INDOMIE_GORENG_ID = "22222222-2222-4222-8222-222222222201";
export const AQUA_600_ID = "22222222-2222-4222-8222-222222222202";
export const INDOMIE_SOTO_ID = "22222222-2222-4222-8222-222222222206";
export const INDOMIE_KARI_ID = "22222222-2222-4222-8222-222222222207";
export const MINYAK_1L_ID = "22222222-2222-4222-8222-222222222205";
export const MINYAK_2L_ID = "22222222-2222-4222-8222-222222222208";
export const TEH_BOTOL_ID = "22222222-2222-4222-8222-222222222209";

/** Katalog default: satu varian Indomie saja, supaya substitusi varian terdeteksi. */
export const defaultCatalog: ProductSeed[] = [
  {
    id: INDOMIE_GORENG_ID,
    sku: "ML-IND-GRG-DUS",
    name: "Indomie Goreng",
    description: "Mie instan goreng per dus untuk kebutuhan retail.",
    unit: "dus",
    price: 115000,
    quantity: 57,
  },
  {
    id: AQUA_600_ID,
    sku: "ML-AQA-600-CRT",
    name: "Aqua 600 ml",
    description: "Air mineral 600 ml per karton.",
    unit: "karton",
    price: 48000,
    quantity: 42,
  },
];

export const multiVariantCatalog: ProductSeed[] = [
  ...defaultCatalog,
  {
    id: INDOMIE_SOTO_ID,
    sku: "ML-IND-STO-DUS",
    name: "Indomie Soto",
    description: "Mie instan kuah soto per dus.",
    unit: "dus",
    price: 112000,
    quantity: 30,
  },
  {
    id: INDOMIE_KARI_ID,
    sku: "ML-IND-KRA-DUS",
    name: "Indomie Kari Ayam",
    description: "Mie instan kuah kari ayam per dus.",
    unit: "dus",
    price: 113000,
    quantity: 21,
  },
];

/** Katalog untuk percakapan belanja banyak produk sekaligus. */
export const basketCatalog: ProductSeed[] = [
  ...defaultCatalog,
  {
    id: TEH_BOTOL_ID,
    sku: "ML-TEH-BTL-DUS",
    name: "Teh Botol",
    description: "Teh botol kemasan per dus.",
    unit: "dus",
    price: 62000,
    quantity: 25,
  },
  {
    id: MINYAK_1L_ID,
    sku: "ML-MYG-1L-DUS",
    name: "Minyak Goreng 1 L",
    description: "Minyak goreng kemasan 1 liter per karton.",
    unit: "karton",
    price: 156000,
    quantity: 30,
  },
];

export const minyakCatalog: ProductSeed[] = [
  {
    id: MINYAK_1L_ID,
    sku: "ML-MYG-1L-DUS",
    name: "Minyak Goreng 1 L",
    description: "Minyak goreng kemasan 1 liter per dus.",
    unit: "dus",
    price: 156000,
    quantity: 30,
  },
];

export const testPaymentAccounts: PaymentAccount[] = [
  {
    id: "44444444-4444-4444-8444-444444444401",
    company_id: DEFAULT_COMPANY_ID,
    bank_name: "Bank Dummy Development",
    account_number: "0000000000",
    account_name: "CV Maju Lancar Dev Only",
    active: true,
    created_at: "2026-09-12T00:00:00.000Z",
  },
];

export type MutableBusinessRepository = BusinessRepository & {
  setInventory(productId: string, quantity: number): void;
  setPrice(productId: string, price: number): void;
  setProductUnits(productId: string, units: ProductUnit[]): void;
  setUnitConversions(productId: string, conversions: UnitConversion[]): void;
  setPaymentAccounts(accounts: PaymentAccount[]): void;
  failNextRead(message?: string): void;
};

function now() {
  return new Date().toISOString();
}

function toProduct(seed: ProductSeed): Product {
  return {
    id: seed.id,
    company_id: DEFAULT_COMPANY_ID,
    sku: seed.sku,
    name: seed.name,
    description: seed.description ?? null,
    unit: seed.unit,
    price: seed.price,
    active: seed.active ?? true,
    created_at: "2026-09-12T00:00:00.000Z",
    updated_at: "2026-09-12T00:00:00.000Z",
  };
}

/** Membentuk baris produk seperti yang dikembalikan Supabase. */
export function buildProducts(catalog: ProductSeed[]): Product[] {
  return catalog.map(toProduct);
}

/**
 * Repository in-memory untuk test. Bentuk datanya mengikuti tabel Supabase,
 * sehingga business engine diuji lewat jalur yang sama dengan produksi.
 */
export function createMutableBusinessRepository(
  catalog: ProductSeed[] = defaultCatalog,
): MutableBusinessRepository {
  const products = catalog.map(toProduct);
  const inventory: InventoryItem[] = catalog.map((seed, index) => ({
    id: `33333333-3333-4333-8333-3333333333${String(index).padStart(2, "0")}`,
    company_id: DEFAULT_COMPANY_ID,
    product_id: seed.id,
    quantity_on_hand: seed.quantity,
    quantity_reserved: 0,
    updated_at: "2026-09-12T00:00:00.000Z",
  }));

  const productUnits = new Map<string, ProductUnit[]>(
    catalog.map((seed) => [
      seed.id,
      (seed.productUnits ?? [
        {
          unit_code: seed.unit,
          is_sellable: true,
          is_base_unit: true,
          conversion_to_base: 1,
          selling_price: seed.price,
          min_quantity: 1,
          quantity_step: 1,
        },
      ]).map((unit, index) => ({
        id: `55555555-5555-4555-8555-${seed.id.slice(-8)}${String(index).padStart(2, "0")}`,
        company_id: DEFAULT_COMPANY_ID,
        product_id: seed.id,
        unit_code: unit.unit_code,
        is_sellable: unit.is_sellable,
        is_base_unit: unit.is_base_unit ?? unit.unit_code === seed.unit,
        conversion_to_base: unit.conversion_to_base,
        selling_price: unit.selling_price ?? null,
        min_quantity: unit.min_quantity ?? 1,
        quantity_step: unit.quantity_step ?? 1,
        created_at: "2026-09-12T00:00:00.000Z",
        updated_at: "2026-09-12T00:00:00.000Z",
      })),
    ]),
  );

  const conversions = new Map<string, UnitConversion[]>();
  let paymentAccounts = [...testPaymentAccounts];
  const conversations: Conversation[] = [];
  const messages: Message[] = [];
  const handoffs: HumanHandoff[] = [];
  let pendingReadFailure: string | null = null;

  function checkFailure() {
    if (pendingReadFailure) {
      const message = pendingReadFailure;
      pendingReadFailure = null;
      throw new Error(message);
    }
  }

  return {
    async confirmOrder() { throw new Error("Use the PostgreSQL integration repository for order persistence"); },
    async getOrder() { return null; },
    async listOrders() { return []; },
    async changeOrderStatus() { throw new Error("ORDER_NOT_FOUND"); },
    async recordBusinessAudit() {},
    setInventory(productId, quantity) {
      const item = inventory.find((entry) => entry.product_id === productId);
      if (!item) {
        throw new Error(`Inventory for ${productId} not found`);
      }
      item.quantity_on_hand = quantity;
      item.updated_at = now();
    },

    setPrice(productId, price) {
      const product = products.find((entry) => entry.id === productId);
      if (!product) {
        throw new Error(`Product ${productId} not found`);
      }
      product.price = price;
      product.updated_at = now();

      const baseUnit = productUnits.get(productId)?.find((unit) => unit.is_base_unit);
      if (baseUnit?.is_sellable) {
        baseUnit.selling_price = price;
        baseUnit.updated_at = now();
      }
    },

    setProductUnits(productId, next) {
      productUnits.set(productId, next);
    },

    setUnitConversions(productId, next) {
      conversions.set(productId, next);
    },

    setPaymentAccounts(accounts) {
      paymentAccounts = [...accounts];
    },

    failNextRead(message = "supabase unavailable") {
      pendingReadFailure = message;
    },

    async getCompany(companyId) {
      return companyId === testCompany.id ? testCompany : null;
    },

    async listProducts(companyId) {
      checkFailure();
      return products.filter((product) => product.company_id === companyId);
    },

    async listActiveProducts(companyId, limit, offset) {
      checkFailure();
      return products
        .filter((product) => product.company_id === companyId && product.active)
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(offset, offset + limit);
    },

    async getProduct(companyId, productId) {
      checkFailure();
      return (
        products.find(
          (product) => product.company_id === companyId && product.id === productId && product.active,
        ) ?? null
      );
    },

    async getInventory(companyId, productId) {
      checkFailure();
      return (
        inventory.find((item) => item.company_id === companyId && item.product_id === productId) ?? null
      );
    },

    async listProductUnits(_companyId, productId) {
      checkFailure();
      return productUnits.get(productId) ?? [];
    },

    async listUnitConversions(_companyId, productId) {
      return conversions.get(productId) ?? [];
    },

    async listPaymentAccounts(companyId) {
      checkFailure();
      return paymentAccounts.filter(
        (account) => account.company_id === companyId && account.active,
      );
    },

    async upsertConversation(companyId, sessionId) {
      const existing = conversations.find(
        (conversation) =>
          conversation.company_id === companyId && conversation.session_id === sessionId,
      );

      if (existing) {
        return existing;
      }

      const conversation: Conversation = {
        id: crypto.randomUUID(),
        company_id: companyId,
        session_id: sessionId,
        state: {},
        ownership: "AI_ACTIVE",
        created_at: now(),
        updated_at: now(),
      };

      conversations.push(conversation);
      return conversation;
    },

    async resetConversationSession(companyId, sessionId) {
      const conversation = await this.upsertConversation(companyId, sessionId);

      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].conversation_id === conversation.id) {
          messages.splice(index, 1);
        }
      }

      for (const handoff of handoffs) {
        if (
          handoff.conversation_id === conversation.id &&
          (handoff.status === "PENDING" || handoff.status === "ACTIVE")
        ) {
          handoff.status = "CLOSED";
          handoff.resolved_at = now();
        }
      }

      conversation.state = {};
      conversation.ownership = "AI_ACTIVE";
      conversation.updated_at = now();
      return conversation;
    },

    async getConversation(companyId, conversationId) {
      return (
        conversations.find(
          (conversation) =>
            conversation.company_id === companyId && conversation.id === conversationId,
        ) ?? null
      );
    },

    async listConversationsByOwnership(companyId, ownerships) {
      return conversations.filter(
        (conversation) =>
          conversation.company_id === companyId && ownerships.includes(conversation.ownership),
      );
    },

    async saveConversationState(conversationId, state) {
      const conversation = conversations.find((item) => item.id === conversationId);
      if (conversation) {
        conversation.state = state;
        conversation.updated_at = now();
      }
    },

    async setConversationOwnership(conversationId, ownership) {
      const conversation = conversations.find((item) => item.id === conversationId);
      if (conversation) {
        conversation.ownership = ownership;
        conversation.updated_at = now();
      }
    },

    async addMessage(conversationId, role: MessageRole, content, sender: MessageSender) {
      const message: Message = {
        id: crypto.randomUUID(),
        conversation_id: conversationId,
        role,
        sender,
        content,
        created_at: now(),
      };

      messages.push(message);
      return message;
    },

    async listMessages(conversationId, limit) {
      return messages.filter((message) => message.conversation_id === conversationId).slice(-limit);
    },

    async findOpenHandoff(conversationId) {
      return (
        handoffs.find(
          (handoff) =>
            handoff.conversation_id === conversationId &&
            (handoff.status === "PENDING" || handoff.status === "ACTIVE"),
        ) ?? null
      );
    },

    async createHandoff(input) {
      const existing = handoffs.find(
        (handoff) =>
          handoff.conversation_id === input.conversationId &&
          (handoff.status === "PENDING" || handoff.status === "ACTIVE"),
      );

      if (existing) {
        return existing;
      }

      const handoff: HumanHandoff = {
        id: crypto.randomUUID(),
        conversation_id: input.conversationId,
        reason: input.reason,
        reason_code: input.reasonCode,
        summary: input.summary,
        metadata: input.metadata,
        status: "PENDING",
        created_at: now(),
        claimed_at: null,
        resolved_at: null,
      };

      handoffs.push(handoff);
      return handoff;
    },

    async claimHandoff(handoffId) {
      const handoff = handoffs.find((item) => item.id === handoffId);

      // Transisi bersyarat, meniru UPDATE ... WHERE status = 'PENDING'.
      if (!handoff || handoff.status !== "PENDING") {
        return null;
      }

      handoff.status = "ACTIVE";
      handoff.claimed_at = now();
      return handoff;
    },

    async closeHandoff(handoffId, status) {
      const handoff = handoffs.find((item) => item.id === handoffId);

      if (!handoff || (handoff.status !== "PENDING" && handoff.status !== "ACTIVE")) {
        return null;
      }

      handoff.status = status;
      handoff.resolved_at = now();
      return handoff;
    },

    async listHandoffs(companyId, statuses) {
      const conversationIds = new Set(
        conversations
          .filter((conversation) => conversation.company_id === companyId)
          .map((conversation) => conversation.id),
      );

      return handoffs
        .filter(
          (handoff) =>
            conversationIds.has(handoff.conversation_id) && statuses.includes(handoff.status),
        )
        .slice()
        .reverse();
    },

    async getHandoff(handoffId) {
      return handoffs.find((item) => item.id === handoffId) ?? null;
    },
  };
}
