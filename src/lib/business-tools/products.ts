import { resolveProductQuery, resolutionFromContext, toPublicProduct } from "@/lib/business/product-resolver";
import type { ProductResolution } from "@/lib/business/types";
import type { BusinessToolContext } from "./recorder";
import type { Product, PublicListedProduct } from "./types";

function toolShape(resolution: ProductResolution) {
  return {
    ok: true,
    status: resolution.status,
    match_type: resolution.match_type,
    requested_query: resolution.requested_query,
    normalized_query: resolution.normalized_query,
    confidence: resolution.confidence,
    reason: resolution.reason,
    products: resolution.candidates.map((candidate) => ({
      ...candidate.product,
      confidence: candidate.confidence,
      match_reason: candidate.reason,
    })),
    suggestions: resolution.suggestions.map((candidate) => ({
      ...candidate.product,
      confidence: candidate.confidence,
      match_reason: candidate.reason,
    })),
    resolved_product:
      resolution.status === "EXACT" || resolution.status === "FUZZY_SAFE" ? resolution.product : null,
  };
}

export type ProductLookup = {
  resolution: ProductResolution;
  product: Product | null;
};

export type ActiveProductList = {
  products: PublicListedProduct[];
  limit: number;
  offset: number;
  has_more: boolean;
};

function toPublicListedProduct(product: Product): PublicListedProduct {
  return {
    ...toPublicProduct(product),
    price: product.price,
  };
}

/**
 * Daftar produk aktif untuk intent PRODUCT_LIST. Nama produk selalu berasal dari
 * Supabase/repository, bukan dari model bahasa atau prompt statis.
 */
export async function listActiveProducts(
  context: BusinessToolContext,
  input: { limit: number; offset: number },
): Promise<ActiveProductList> {
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit)));
  const offset = Math.max(0, Math.floor(input.offset));

  return context.recorder.run("list_active_products", { limit, offset }, async () => {
    const rows = await context.repository.listActiveProducts(context.companyId, limit + 1, offset);

    return {
      products: rows.slice(0, limit).map(toPublicListedProduct),
      limit,
      offset,
      has_more: rows.length > limit,
    };
  });
}

/**
 * Satu-satunya jalan masuk untuk mengubah kata-kata customer menjadi identitas
 * produk. Pencocokannya deterministik dan berlaku untuk seluruh katalog.
 */
export async function searchProducts(
  context: BusinessToolContext,
  query: string,
  options: { restrictToProductIds?: string[] } = {},
): Promise<ProductLookup> {
  const products = context.catalog ?? (await context.repository.listProducts(context.companyId));
  const resolution = resolveProductQuery(products, query, options);

  await context.recorder.run(
    "search_products",
    { query, restrict_to_product_ids: options.restrictToProductIds ?? null },
    async () => toolShape(resolution),
  );

  const resolvedId = resolution.product?.id;

  return {
    resolution,
    product: resolvedId ? products.find((item) => item.id === resolvedId) ?? null : null,
  };
}

/**
 * Mengambil produk dari konteks percakapan. Identitasnya berasal dari turn
 * sebelumnya, tetapi barisnya selalu dibaca ulang dari database.
 */
export async function getProductById(
  context: BusinessToolContext,
  productId: string,
  requestedQuery = "",
): Promise<ProductLookup | null> {
  const row = await context.repository.getProduct(context.companyId, productId);

  await context.recorder.run("get_product", { product_id: productId }, async () =>
    row
      ? { ok: true, found: true, product: toPublicProduct(row) }
      : { ok: true, found: false, product: null },
  );

  if (!row) {
    return null;
  }

  return {
    resolution: resolutionFromContext(row, requestedQuery || row.name),
    product: row,
  };
}
