import type { OrderValidation, QuantityValidation, UnitResolution } from "@/lib/business/types";
import type { BusinessToolContext } from "./recorder";
import type { Product, ProductUnit } from "./types";

/**
 * validate_order adalah satu-satunya otoritas yang boleh menyatakan sebuah
 * pesanan dapat dilanjutkan. Hasilnya deterministik dan tidak boleh di-override
 * oleh model bahasa.
 */
export async function validateOrder(
  context: BusinessToolContext,
  input: {
    product: Product;
    quantity: QuantityValidation;
    unit: UnitResolution;
    productUnit: ProductUnit;
    stockQuantity: number;
  },
): Promise<OrderValidation> {
  const { product, quantity, unit, productUnit, stockQuantity } = input;

  return context.recorder.run(
    "validate_order",
    {
      product_id: product.id,
      quantity: quantity.quantity,
      requested_unit: unit.requested_unit,
      sellable_unit: productUnit.unit_code,
    },
    async () => {
      const unitMatch = unit.status !== "NEEDS_CLARIFICATION";
      const unitSellable =
        productUnit.is_sellable && productUnit.selling_price !== null && unitMatch;
      const effectiveQuantity = unit.quantity_in_inventory_unit;

      let reason = "ORDER_READY";
      let orderAllowed = true;
      let sufficientStock = false;

      if (quantity.status === "MISSING") {
        reason = "QUANTITY_REQUIRED";
        orderAllowed = false;
      } else if (quantity.status === "INVALID_QUANTITY") {
        reason = "INVALID_QUANTITY";
        orderAllowed = false;
      } else if (!unitMatch || effectiveQuantity === null) {
        reason = "NEEDS_CLARIFICATION";
        orderAllowed = false;
      } else if (!unitSellable) {
        reason = "UNIT_NOT_SELLABLE";
        orderAllowed = false;
      } else if (effectiveQuantity > stockQuantity) {
        reason = "INSUFFICIENT_STOCK";
        orderAllowed = false;
      } else {
        sufficientStock = true;
      }

      const validation: OrderValidation = {
        product_id: product.id,
        product_name: product.name,
        requested_quantity: quantity.quantity,
        requested_unit: unit.requested_unit ?? productUnit.unit_code,
        stock_quantity: stockQuantity,
        stock_unit: product.unit,
        unit_match: unitMatch,
        sellable_unit: productUnit.unit_code,
        unit_sellable: unitSellable,
        sufficient_stock: sufficientStock,
        maximum_available: stockQuantity,
        order_allowed: orderAllowed,
        reason,
      };

      return validation;
    },
  );
}
