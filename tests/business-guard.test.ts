import { describe, expect, it } from "vitest";
import { processBusinessRequest } from "@/lib/business/business-engine";
import { structuredRequestSchema, type StructuredRequest } from "@/lib/business/types";
import { evaluateBusinessGuard } from "@/lib/business-guard";
import { DEFAULT_COMPANY_ID } from "@/lib/company";
import {
  createMutableBusinessRepository,
  defaultCatalog,
  testPaymentAccounts,
  type ProductSeed,
} from "./helpers/mutable-repository";

async function resultFor(partial: Partial<StructuredRequest>, catalog: ProductSeed[] = defaultCatalog) {
  const { result } = await processBusinessRequest({
    repository: createMutableBusinessRepository(catalog),
    companyId: DEFAULT_COMPANY_ID,
    conversationId: "conversation-1",
    request: structuredRequestSchema.parse({ intent: "UNKNOWN", ...partial }),
    state: {},
  });

  return result;
}

function guard(response: string, businessResult: Awaited<ReturnType<typeof resultFor>>) {
  return evaluateBusinessGuard({
    response,
    businessResult,
    officialPaymentAccounts: testPaymentAccounts,
  });
}

describe("business guard", () => {
  it("memblokir angka stok yang tidak ada pada business result", async () => {
    const result = await resultFor({ intent: "STOCK_CHECK", product_query: "indomie goreng" });
    const blocked = guard("Masih ada, Kak. Stok Indomie Goreng 80 dus.", result);

    expect(blocked.allowed).toBe(false);
    expect(blocked.fallbackReason).toBe("quantity_integrity");
    expect(guard("Masih ada, Kak. Stok Indomie Goreng 57 dus.", result).allowed).toBe(true);
  });

  it("memblokir harga yang tidak sama dengan database", async () => {
    const result = await resultFor({ intent: "PRICE_CHECK", product_query: "indomie goreng" });

    expect(guard("Harganya Rp125.000 per dus.", result).fallbackReason).toBe("money_integrity");
    expect(guard("Harganya Rp115.000 per dus.", result).allowed).toBe(true);
  });

  it("memblokir persetujuan order saat order_allowed false", async () => {
    const result = await resultFor({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity: 80,
      unit: "dus",
    });

    expect(result.order_allowed).toBe(false);
    expect(guard("Siap, pesanan 57 dus siap diproses ya, Kak.", result).fallbackReason).toBe(
      "order_status_integrity",
    );
    expect(guard("Stoknya mencukupi kok, Kak.", result).fallbackReason).toBe("order_status_integrity");
    expect(
      guard("Untuk 80 dus belum bisa terpenuhi semua, stok yang ada 57 dus.", result).allowed,
    ).toBe(true);
  });

  it("mengizinkan quote menyebut jumlah masih dalam stok tanpa mengklaim order dibuat", async () => {
    const result = await resultFor({
      intent: "QUOTE",
      product_query: "indomie goreng",
      quantity: 5,
      unit: "dus",
    });

    expect(result.stock_sufficient).toBe(true);
    expect(result.order_allowed).toBe(false);
    expect(
      guard("Untuk 5 dus totalnya Rp575.000, Kak. Jumlah itu masih dalam stok yang tersedia.", result)
        .allowed,
    ).toBe(true);
  });

  it("memblokir klaim pesanan sudah dibuat walaupun stok cukup", async () => {
    const result = await resultFor({
      intent: "ORDER_REQUEST",
      product_query: "indomie goreng",
      quantity: 50,
      unit: "dus",
    });

    expect(result.order_allowed).toBe(true);
    expect(guard("Pesanan sudah dibuat ya, Kak.", result).fallbackReason).toBe(
      "order_status_integrity",
    );
    // Selama customer masih memilih barang, total belum dihitung - menyebut
    // angka total berarti mengarang.
    const withTotal = guard("Siap, 50 dus totalnya Rp5.750.000.", result);
    expect(withTotal.allowed).toBe(false);
    expect(withTotal.checks.filter((check) => check.status === "blocked").map((check) => check.name)).toContain(
      "money_integrity",
    );

    expect(
      guard("Siap, Indomie Goreng 50 dus saya catat. Ada lagi yang mau ditambahkan?", result).allowed,
    ).toBe(true);
  });

  it("memblokir klaim ketersediaan saat produk belum dipastikan", async () => {
    const result = await resultFor({ intent: "STOCK_CHECK", product_query: "indomie soto" });

    expect(guard("Masih ada, Kak. Indomie Soto tersedia.", result).fallbackReason).toBe(
      "product_identity",
    );
    expect(
      guard(
        "Untuk Indomie Soto belum saya temukan, Kak. Yang tercatat Indomie Goreng.",
        result,
      ).allowed,
    ).toBe(true);
  });

  it("memblokir rekening di luar whitelist", async () => {
    const result = await resultFor({ intent: "PAYMENT_INFO" });

    expect(guard("Silakan transfer ke rekening 123456789 ya.", result).fallbackReason).toBe(
      "payment_account_whitelist",
    );
    expect(
      guard("Silakan transfer ke rekening Bank Dummy Development 0000000000.", result)
        .fallbackReason,
    ).toBe("payment_account_identity");
    expect(
      guard(
        "Silakan transfer ke rekening Bank Dummy Development 0000000000 a.n. CV Maju Lancar Dev Only.",
        result,
      ).allowed,
    ).toBe(true);
  });

  it("memblokir janji pengiriman", async () => {
    const result = await resultFor({ intent: "DELIVERY_CHECK" });

    expect(guard("Tenang, barangnya pasti sampai besok kok.", result).fallbackReason).toBe(
      "delivery_certainty",
    );
  });

  it("memblokir istilah internal yang bocor ke customer", async () => {
    const result = await resultFor({ intent: "STOCK_CHECK", product_query: "indomie goreng" });

    expect(guard("Status: STOCK_AVAILABLE, stok 57 dus.", result).fallbackReason).toBe(
      "internal_language",
    );
  });

  it("angka pada nama produk tidak dianggap klaim jumlah", async () => {
    const result = await resultFor({ intent: "STOCK_CHECK", product_query: "aqua 600 ml" });

    expect(guard("Aqua 600 ml masih ada 42 karton, Kak.", result).allowed).toBe(true);
  });

  it("memblokir persetujuan diskon", async () => {
    const result = await resultFor({ intent: "DISCOUNT_REQUEST" });

    expect(guard("Oke, diskon 10% bisa kami berikan.", result).fallbackReason).toBe(
      "discount_authorization",
    );
  });
});
