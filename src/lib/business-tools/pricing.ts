import type { BusinessToolContext } from "./recorder";
import type { Product, ProductUnit } from "./types";

export type PriceSnapshot = {
  product_id: string;
  unit_price: number;
  unit: string;
};

export type OrderCalculation = {
  product_id: string;
  quantity: number;
  unit: string;
  unit_price: number;
  total_price: number;
};

/**
 * Harga dibaca ulang dari database. Baris produk yang dipakai adalah hasil
 * fetch pada request ini, bukan harga yang pernah disebut di percakapan.
 */
export async function getPrice(
  context: BusinessToolContext,
  product: Product,
  unit?: ProductUnit,
): Promise<PriceSnapshot> {
  return context.recorder.run("get_price", { product_id: product.id, unit: unit?.unit_code ?? null }, async () => {
    if (unit) {
      if (!unit.is_sellable || unit.selling_price === null) {
        throw new Error("SELLABLE_UNIT_PRICE_UNAVAILABLE");
      }

      return {
        product_id: product.id,
        unit_price: unit.selling_price,
        unit: unit.unit_code,
      };
    }

    const fresh = await context.repository.getProduct(context.companyId, product.id);
    const row = fresh ?? product;

    return {
      product_id: row.id,
      unit_price: row.price,
      unit: row.unit,
    };
  });
}

/**
 * Kalkulasi deterministik. Hanya dipanggil setelah satuan valid, sehingga tidak
 * pernah mengalikan jumlah dengan harga dari satuan yang berbeda.
 */
export async function calculateOrder(
  context: BusinessToolContext,
  input: { product: Product; quantity: number; unit: string; unitPrice: number },
): Promise<OrderCalculation> {
  return context.recorder.run(
    "calculate_order",
    { product_id: input.product.id, quantity: input.quantity, unit: input.unit },
    async () => ({
      product_id: input.product.id,
      quantity: input.quantity,
      unit: input.unit,
      unit_price: input.unitPrice,
      total_price: Math.round(input.unitPrice * input.quantity * 100) / 100,
    }),
  );
}
