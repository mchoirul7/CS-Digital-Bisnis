import type { PackagingFact } from "@/lib/business/types";
import { unitsAreSame } from "@/lib/business/unit-resolver";
import { listUnitConversions } from "./inventory";
import type { BusinessToolContext } from "./recorder";
import type { Product } from "./types";

function roundQuantity(value: number) {
  return Number(value.toFixed(3));
}

/**
 * Isi kemasan hanya boleh dijawab kalau ada baris konversi satuan resmi.
 * Kalau tidak ada, hasilnya null dan business engine menjawab "belum tercatat" -
 * tidak pernah menebak berapa bungkus per dus.
 */
export async function getPackagingFact(
  context: BusinessToolContext,
  product: Product,
): Promise<PackagingFact | null> {
  const conversions = await listUnitConversions(context, product);

  for (const conversion of conversions) {
    if (!Number.isFinite(conversion.factor) || conversion.factor <= 0) {
      continue;
    }

    if (unitsAreSame(conversion.from_unit, product.unit)) {
      return {
        outer_unit: product.unit,
        inner_unit: conversion.to_unit,
        quantity_per_outer: roundQuantity(conversion.factor),
        source: "unit_conversions",
      };
    }

    if (unitsAreSame(conversion.to_unit, product.unit)) {
      return {
        outer_unit: product.unit,
        inner_unit: conversion.from_unit,
        quantity_per_outer: roundQuantity(1 / conversion.factor),
        source: "unit_conversions",
      };
    }
  }

  return null;
}
