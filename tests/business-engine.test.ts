import { describe, expect, it } from "vitest";
import { processBusinessRequest } from "@/lib/business/business-engine";
import { structuredRequestSchema, type StructuredRequest } from "@/lib/business/types";
import type { ConversationState } from "@/lib/chat/conversation-state";
import { DEFAULT_COMPANY_ID } from "@/lib/company";
import {
  createMutableBusinessRepository,
  defaultCatalog,
  INDOMIE_GORENG_ID,
  multiVariantCatalog,
  type MutableBusinessRepository,
  type ProductSeed,
} from "./helpers/mutable-repository";

function request(partial: Partial<StructuredRequest>): StructuredRequest {
  return structuredRequestSchema.parse({ intent: "UNKNOWN", ...partial });
}

async function run(
  partial: Partial<StructuredRequest>,
  options: {
    repository?: MutableBusinessRepository;
    catalog?: ProductSeed[];
    state?: ConversationState;
  } = {},
) {
  const repository =
    options.repository ?? createMutableBusinessRepository(options.catalog ?? defaultCatalog);

  const { result, toolCalls } = await processBusinessRequest({
    repository,
    companyId: DEFAULT_COMPANY_ID,
    conversationId: "conversation-1",
    request: request(partial),
    state: options.state ?? {},
  });

  return { result, toolCalls, repository };
}

describe("B. stock check", () => {
  it("daftar produk aktif berasal dari database", async () => {
    const { result, toolCalls } = await run(
      { intent: "PRODUCT_LIST" },
      {
        catalog: [
          ...defaultCatalog,
          {
            id: "22222222-2222-4222-8222-222222222299",
            sku: "ML-HDN-001",
            name: "Produk Nonaktif",
            unit: "dus",
            price: 1,
            quantity: 1,
            active: false,
          },
        ],
      },
    );

    expect(result.status).toBe("PRODUCT_LISTED");
    expect(result.listed_products.map((product) => product.name)).toEqual([
      "Aqua 600 ml",
      "Indomie Goreng",
    ]);
    expect(result.listed_products.map((product) => product.price)).toEqual([48_000, 115_000]);
    expect(result.pagination).toMatchObject({ limit: 20, offset: 0, has_more: false });
    expect(toolCalls.map((call) => call.tool_name)).toEqual(["list_active_products"]);
  });

  it("greeting dan thanks tidak masuk workflow bisnis berat", async () => {
    const greeting = await run({ intent: "GREETING" });
    const thanks = await run({ intent: "THANKS" });

    expect(greeting.result.status).toBe("GREETING_RESPONSE");
    expect(thanks.result.status).toBe("THANKS_RESPONSE");
    expect(greeting.toolCalls).toEqual([]);
    expect(thanks.toolCalls).toEqual([]);
  });

  it("stok berasal dari database", async () => {
    const { result } = await run({ intent: "STOCK_CHECK", product_query: "indomie goreng" });

    expect(result.status).toBe("STOCK_AVAILABLE");
    expect(result.availability).toEqual({ quantity: 57, unit: "dus" });
    expect(result.price).toBe(115_000);
    expect(result.product?.name).toBe("Indomie Goreng");
  });

  it("instruksi customer tidak mengubah angka stok", async () => {
    const { result } = await run({
      intent: "STOCK_CHECK",
      product_query: "indomie goreng",
      quantity: 100,
      unit: "dus",
    });

    expect(result.availability?.quantity).toBe(57);
  });

  it("stok kosong dilaporkan apa adanya", async () => {
    const repository = createMutableBusinessRepository();
    repository.setInventory(INDOMIE_GORENG_ID, 0);

    const { result } = await run(
      { intent: "STOCK_CHECK", product_query: "indomie goreng" },
      { repository },
    );

    expect(result.status).toBe("OUT_OF_STOCK");
    expect(result.availability?.quantity).toBe(0);
  });

  it("varian yang tidak ada tidak pernah dicek stoknya", async () => {
    const { result, toolCalls } = await run({
      intent: "STOCK_CHECK",
      product_query: "indomie soto",
    });

    expect(result.status).toBe("PRODUCT_NOT_FOUND");
    expect(result.availability).toBeNull();
    expect(toolCalls.map((call) => call.tool_name)).not.toContain("get_stock");
    expect(result.suggestions.map((product) => product.name)).toEqual(["Indomie Goreng"]);
  });

  it("varian ambigu tidak dipilih sendiri", async () => {
    const { result, toolCalls } = await run(
      { intent: "STOCK_CHECK", product_query: "indomie" },
      { catalog: multiVariantCatalog },
    );

    expect(result.status).toBe("PRODUCT_AMBIGUOUS");
    expect(result.candidates).toHaveLength(3);
    expect(toolCalls.map((call) => call.tool_name)).not.toContain("get_stock");
  });
});

describe("C. order validation", () => {
  it.each([
    [50, "READY_FOR_CONFIRMATION", true],
    [57, "READY_FOR_CONFIRMATION", true],
    [58, "INSUFFICIENT_STOCK", false],
    [80, "INSUFFICIENT_STOCK", false],
  ])("pesan %s dus menghasilkan %s", async (quantity, status, allowed) => {
    const { result } = await run({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity,
      unit: "dus",
    });

    expect(result.status).toBe(status);
    expect(result.order_allowed).toBe(allowed);
    expect(result.availability?.quantity).toBe(57);
    expect(result.maximum_available).toBe(57);
  });

  it("kekurangan dihitung deterministik", async () => {
    const { result } = await run({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity: 80,
      unit: "dus",
    });

    expect(result.shortfall).toBe(23);
    expect(result.total).toBeNull();
    expect(result.price).toBe(115000);
  });

  it.each([[0], [-5]])("jumlah %s ditolak sebelum kalkulasi", async (quantity) => {
    const { result, toolCalls } = await run({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity,
      unit: "dus",
    });

    expect(result.status).toBe("INVALID_QUANTITY");
    expect(result.order_allowed).toBe(false);
    expect(toolCalls.map((call) => call.tool_name)).not.toContain("calculate_order");
  });

  it("jumlah sangat besar tetap diuji terhadap stok nyata", async () => {
    const { result } = await run({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity: 1000,
      unit: "dus",
    });

    expect(result.status).toBe("INSUFFICIENT_STOCK");
    expect(result.availability?.quantity).toBe(57);
  });

  it("jumlah yang belum disebut diminta dulu tanpa membaca konversi satuan", async () => {
    const { result, toolCalls } = await run({ intent: "ORDER_REQUEST", product_query: "indomie goreng" });

    expect(result.status).toBe("QUANTITY_REQUIRED");
    expect(result.order_allowed).toBe(false);
    expect(toolCalls.map((call) => call.tool_name)).not.toContain("list_unit_conversions");
  });

  it("satuan exact tidak bergantung ke tabel konversi satuan", async () => {
    const { result, toolCalls } = await run({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity: 2,
      unit: "dus",
    });

    expect(result.status).toBe("READY_FOR_CONFIRMATION");
    expect(toolCalls.map((call) => call.tool_name)).not.toContain("list_unit_conversions");
  });

  it("validate_order tercatat sebagai business tool", async () => {
    const { toolCalls } = await run({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity: 80,
      unit: "dus",
    });

    const validation = toolCalls.find((call) => call.tool_name === "validate_order");

    expect(validation?.database_result).toMatchObject({
      product_name: "Indomie Goreng",
      requested_quantity: 80,
      requested_unit: "dus",
      stock_quantity: 57,
      stock_unit: "dus",
      unit_match: true,
      sufficient_stock: false,
      maximum_available: 57,
      order_allowed: false,
      reason: "INSUFFICIENT_STOCK",
    });
  });
});

describe("D. unit handling", () => {
  it("satuan asing tidak diam-diam diubah", async () => {
    const { result, toolCalls } = await run({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity: 80,
      unit: "bungkus",
    });

    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect(result.unit_match).toBe(false);
    expect(result.order_allowed).toBe(false);
    expect(result.total).toBeNull();
    expect(result.unit_resolution?.inventory_unit).toBe("dus");
    expect(toolCalls.map((call) => call.tool_name)).not.toContain("calculate_order");
  });

  it("konversi resmi dari database dipakai setelah tersedia", async () => {
    const repository = createMutableBusinessRepository();
    repository.setUnitConversions(INDOMIE_GORENG_ID, [
      {
        id: "conv-1",
        company_id: DEFAULT_COMPANY_ID,
        product_id: INDOMIE_GORENG_ID,
        from_unit: "bungkus",
        to_unit: "dus",
        factor: 0.025,
      },
    ]);

    const { result } = await run(
      { intent: "ORDER_REQUEST", product_query: "indomie goreng", quantity: 80, unit: "bungkus" },
      { repository },
    );

    expect(result.status).toBe("READY_FOR_CONFIRMATION");
    // 80 bungkus = 2 dus lewat konversi resmi; total baru dihitung saat review.
    expect(result.unit_resolution?.status).toBe("CONVERTIBLE");
    expect(result.unit_resolution?.quantity_in_inventory_unit).toBe(2);
    expect(result.total).toBeNull();
  });
});

describe("E. quotation", () => {
  it("quote tetap dihitung walaupun stok kurang", async () => {
    const { result } = await run({
      intent: "QUOTE",
      product_query: "indomie goreng",
      quantity: 80,
      unit: "dus",
    });

    expect(result.status).toBe("QUOTE_CREATED");
    expect(result.total).toBe(9_200_000);
    expect(result.stock_sufficient).toBe(false);
    expect(result.availability?.quantity).toBe(57);
    expect(result.order_allowed).toBe(false);
  });

  it("quote dengan stok cukup menandai stock_sufficient", async () => {
    const { result } = await run({
      intent: "QUOTE",
      product_query: "indomie goreng",
      quantity: 5,
      unit: "dus",
    });

    expect(result.total).toBe(575_000);
    expect(result.stock_sufficient).toBe(true);
  });
});

describe("F. conversation context", () => {
  it("produk dari konteks dipakai, faktanya tetap dibaca ulang", async () => {
    const repository = createMutableBusinessRepository();

    const first = await run(
      { intent: "QUOTE", quantity: 5, unit: "dus" },
      { repository, state: { activeProduct: { id: INDOMIE_GORENG_ID, name: "Indomie Goreng", unit: "dus" } } },
    );

    expect(first.result.product?.name).toBe("Indomie Goreng");
    expect(first.result.total).toBe(575_000);

    repository.setPrice(INDOMIE_GORENG_ID, 120_000);

    const second = await run(
      { intent: "QUOTE", quantity: 5, unit: "dus" },
      { repository, state: { activeProduct: { id: INDOMIE_GORENG_ID, name: "Indomie Goreng", unit: "dus" } } },
    );

    expect(second.result.total).toBe(600_000);
  });
});

describe("G. live data", () => {
  it("perubahan stok langsung terlihat tanpa restart", async () => {
    const repository = createMutableBusinessRepository();

    const first = await run({ intent: "STOCK_CHECK", product_query: "indomie goreng" }, { repository });
    expect(first.result.availability?.quantity).toBe(57);

    repository.setInventory(INDOMIE_GORENG_ID, 23);

    const second = await run({ intent: "STOCK_CHECK", product_query: "indomie goreng" }, { repository });
    expect(second.result.availability?.quantity).toBe(23);
  });

  it("kegagalan database menghasilkan DATA_UNAVAILABLE, bukan angka karangan", async () => {
    const repository = createMutableBusinessRepository();
    repository.failNextRead("supabase timeout");

    const { result } = await run({ intent: "STOCK_CHECK", product_query: "indomie goreng" }, { repository });

    expect(result.status).toBe("DATA_UNAVAILABLE");
    expect(result.availability).toBeNull();
    expect(result.order_allowed).toBe(false);
  });
});

describe("business facts lain", () => {
  it("rekening hanya dari database", async () => {
    const { result } = await run({ intent: "PAYMENT_INFO" });

    expect(result.status).toBe("PAYMENT_ACCOUNTS");
    expect(result.payment_accounts).toHaveLength(1);
    expect(result.payment_accounts[0].account_number).toBe("0000000000");
  });

  it("review order menghasilkan quote sebelum konfirmasi eksplisit", async () => {
    const { result, toolCalls } = await run(
      { intent: "ORDER_REVIEW" },
      {
        state: {
          draftItems: [
            {
              productId: INDOMIE_GORENG_ID,
              productName: "Indomie Goreng",
              quantity: 7,
              unit: "dus",
              status: "ACTIVE",
              updatedAt: "2026-09-14T00:00:00.000Z",
            },
          ],
        },
      },
    );

    expect(result.status).toBe("ORDER_REVIEWED");
    expect(result.draft?.grand_total).toBe(805_000);
    expect(result.checkout?.items).toHaveLength(1);
    expect(result.persisted_order).toBeUndefined();
    expect(toolCalls.map((call) => call.tool_name)).toEqual(
      expect.arrayContaining(["get_product", "get_stock", "get_price", "calculate_order"]),
    );
  });

  it("review order tidak membutuhkan rekening pembayaran", async () => {
    const repository = createMutableBusinessRepository();
    repository.setPaymentAccounts([]);

    const { result } = await run(
      { intent: "ORDER_REVIEW" },
      {
        repository,
        state: {
          draftItems: [
            {
              productId: INDOMIE_GORENG_ID,
              productName: "Indomie Goreng",
              quantity: 2,
              unit: "dus",
              status: "ACTIVE",
              updatedAt: "2026-09-14T00:00:00.000Z",
            },
          ],
        },
      },
    );

    expect(result.status).toBe("ORDER_REVIEWED");
    expect(result.reason).toBe("ORDER_REVIEW_FROM_CURRENT_DATA");
    expect(result.payment_accounts).toEqual([]);
  });

  it("diskon tanpa aturan diteruskan ke admin", async () => {
    const { result, toolCalls } = await run({ intent: "DISCOUNT_REQUEST" });

    expect(result.status).toBe("DISCOUNT_NOT_AVAILABLE");
    expect(toolCalls.map((call) => call.tool_name)).toContain("request_human_handoff");
  });

  it("pengiriman tidak pernah dijanjikan", async () => {
    const { result, toolCalls } = await run({ intent: "DELIVERY_CHECK" });

    expect(result.status).toBe("DELIVERY_UNAVAILABLE");
    expect(toolCalls.map((call) => call.tool_name)).toContain("get_delivery_information");
  });
});
