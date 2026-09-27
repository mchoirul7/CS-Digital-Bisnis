import { unitsAreSame } from "@/lib/business/unit-resolver";
import type { BusinessToolContext } from "./recorder";
import type { Product, ProductUnit, PublicProductUnit } from "./types";

export function toPublicProductUnit(unit: ProductUnit): PublicProductUnit {
  return {
    product_id: unit.product_id,
    unit_code: unit.unit_code,
    is_sellable: unit.is_sellable,
    is_base_unit: unit.is_base_unit,
    conversion_to_base: unit.conversion_to_base,
    selling_price: unit.selling_price,
    min_quantity: unit.min_quantity,
    quantity_step: unit.quantity_step,
  };
}

export async function listProductUnits(
  context: BusinessToolContext,
  product: Product,
): Promise<ProductUnit[]> {
  return context.recorder.run("list_product_units", { product_id: product.id }, async () => {
    const units = await context.repository.listProductUnits(context.companyId, product.id);
    return units.map((unit) => {
      if (!Number.isFinite(unit.conversion_to_base) || unit.conversion_to_base <= 0) {
        throw new Error("INVALID_CONVERSION");
      }
      const price = unit.selling_price ?? Math.round(product.price * unit.conversion_to_base * 100) / 100;
      return { ...unit, selling_price: Number.isFinite(price) && price >= 0 ? price : null };
    });
  });
}

export function sellableProductUnits(units: ProductUnit[]) {
  return units.filter((unit) => unit.is_sellable);
}

export function findProductUnit(units: ProductUnit[], requestedUnit: string | null | undefined) {
  if (!requestedUnit?.trim()) {
    return null;
  }

  return units.find((unit) => unitsAreSame(unit.unit_code, requestedUnit)) ?? null;
}
