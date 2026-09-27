import { describe, expect, it } from "vitest";
import { resolveProductQuery } from "@/lib/business/product-resolver";
import {
  buildProducts,
  defaultCatalog,
  multiVariantCatalog,
  minyakCatalog,
  type ProductSeed,
} from "./helpers/mutable-repository";

function resolve(query: string, catalog: ProductSeed[] = defaultCatalog) {
  return resolveProductQuery(buildProducts(catalog), query);
}

const minyakDuaLiter: ProductSeed = {
  id: "22222222-2222-4222-8222-222222222208",
  sku: "ML-MYG-2L-DUS",
  name: "Minyak Goreng 2 L",
  description: "Minyak goreng kemasan 2 liter per dus.",
  unit: "dus",
  price: 298000,
  quantity: 12,
};

describe("A. product resolution", () => {
  it("nama persis menghasilkan EXACT", () => {
    const result = resolve("indomie goreng");

    expect(result.status).toBe("EXACT");
    expect(result.product?.name).toBe("Indomie Goreng");
    expect(result.confidence).toBe(1);
  });

  it("SKU persis menghasilkan EXACT", () => {
    const result = resolve("ML-AQA-600-CRT");

    expect(result.status).toBe("EXACT");
    expect(result.product?.name).toBe("Aqua 600 ml");
  });

  it.each([
    ["indomi goreng"],
    ["indomie gorng"],
    ["indome goreng"],
    ["indomie gorengg"],
  ])("typo %s tetap diarahkan ke Indomie Goreng", (query) => {
    const result = resolve(query);

    expect(result.status).toBe("FUZZY_SAFE");
    expect(result.product?.name).toBe("Indomie Goreng");
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("varian yang tidak ada tidak pernah diarahkan ke varian lain", () => {
    const result = resolve("indomie soto");

    expect(result.status).toBe("NOT_FOUND");
    expect(result.product).toBeNull();
    expect(result.suggestions.map((item) => item.product.name)).toEqual(["Indomie Goreng"]);
    expect(result.suggestions[0].reason).toBe("variant_mismatch");
  });

  it("query tanpa varian pada katalog multi varian menghasilkan AMBIGUOUS", () => {
    const result = resolve("indomie", multiVariantCatalog);

    expect(result.status).toBe("AMBIGUOUS");
    expect(result.product).toBeNull();
    expect(result.candidates.map((item) => item.product.name).sort()).toEqual([
      "Indomie Goreng",
      "Indomie Kari Ayam",
      "Indomie Soto",
    ]);
  });

  it("query tanpa varian pada katalog satu varian tetap aman di-resolve", () => {
    const result = resolve("indomie");

    expect(result.status).toBe("FUZZY_SAFE");
    expect(result.product?.name).toBe("Indomie Goreng");
  });

  it("varian yang disebut lengkap tetap terpilih walaupun ada varian lain", () => {
    const result = resolve("indomie soto", multiVariantCatalog);

    expect(result.status).toBe("EXACT");
    expect(result.product?.name).toBe("Indomie Soto");
  });

  it("ukuran berbeda tidak pernah disubstitusi", () => {
    const result = resolve("aqua 1.5 liter");

    expect(result.status).toBe("NOT_FOUND");
    expect(result.suggestions.map((item) => item.product.name)).toEqual(["Aqua 600 ml"]);
    expect(result.suggestions[0].reason).toBe("size_mismatch");
  });

  it("ukuran dengan koma desimal diperlakukan sama", () => {
    expect(resolve("aqua 1,5 liter").status).toBe("NOT_FOUND");
    expect(resolve("aqua 600 ml").status).toBe("EXACT");
  });

  it("volume berbeda pada produk minyak tidak saling menggantikan", () => {
    const catalog = [...minyakCatalog, minyakDuaLiter];

    expect(resolveProductQuery(buildProducts(minyakCatalog), "minyak 2 L").status).toBe("NOT_FOUND");
    expect(resolveProductQuery(buildProducts(catalog), "minyak goreng 2 liter").product?.name).toBe(
      "Minyak Goreng 2 L",
    );
    expect(resolveProductQuery(buildProducts(catalog), "minyak goreng").status).toBe("AMBIGUOUS");
  });

  it("produk yang sama sekali asing menghasilkan NOT_FOUND tanpa saran", () => {
    const result = resolve("kopi kapal api");

    expect(result.status).toBe("NOT_FOUND");
    expect(result.suggestions).toEqual([]);
  });

  it("query kosong tidak pernah memilih produk sendiri", () => {
    const result = resolve("");

    expect(result.status).toBe("NOT_FOUND");
    expect(result.product).toBeNull();
  });

  it("pencarian bisa dipersempit ke kandidat yang sedang dikonfirmasi", () => {
    const products = buildProducts(multiVariantCatalog);
    const ambiguous = resolveProductQuery(products, "indomie");
    const scoped = resolveProductQuery(products, "soto", {
      restrictToProductIds: ambiguous.candidates.map((item) => item.product.id),
    });

    expect(scoped.status).toBe("FUZZY_SAFE");
    expect(scoped.product?.name).toBe("Indomie Soto");
  });
});
