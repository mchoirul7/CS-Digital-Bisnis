import type { BusinessToolContext } from "./recorder";
import type { Product, UnitConversion } from "./types";

export type StockSnapshot = {
  product_id: string;
  quantity: number;
  unit: string;
  updated_at: string | null;
};

/**
 * Stok selalu dibaca ulang dari database pada setiap request. Tidak ada cache
 * dan tidak ada angka stok yang boleh berasal dari riwayat percakapan.
 */
export async function getStock(
  context: BusinessToolContext,
  product: Product,
): Promise<StockSnapshot> {
  return context.recorder.run("get_stock", { product_id: product.id }, async () => {
    const inventory = await context.repository.getInventory(context.companyId, product.id);

    return {
      product_id: product.id,
      quantity: inventory ? inventory.quantity_on_hand - inventory.quantity_reserved : 0,
      unit: product.unit,
      updated_at: inventory?.updated_at ?? null,
    };
  });
}

/**
 * Konversi satuan resmi dari database. Selama tabelnya belum ada, hasilnya
 * kosong sehingga unit resolver meminta klarifikasi alih-alih menebak.
 */
export async function listUnitConversions(
  context: BusinessToolContext,
  product: Product,
): Promise<UnitConversion[]> {
  return context.recorder.run("list_unit_conversions", { product_id: product.id }, async () =>
    context.repository.listUnitConversions(context.companyId, product.id),
  );
}
