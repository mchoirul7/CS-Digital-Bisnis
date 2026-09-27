import type { UnitConversion } from "@/lib/business-tools/types";
import type { UnitResolution } from "./types";

/**
 * Grup alias satuan yang murni perbedaan penulisan/ejaan, bukan konversi jumlah.
 * "kg" dan "kilogram" adalah satuan yang sama; "bungkus" dan "dus" TIDAK.
 */
const UNIT_ALIAS_GROUPS: string[][] = [
  ["kg", "kilogram", "kilo"],
  ["g", "gr", "gram"],
  ["l", "lt", "ltr", "liter", "litre"],
  ["ml", "mililiter", "cc"],
  ["pcs", "pc", "piece", "pieces"],
  ["dus", "dos"],
  ["karton", "carton", "ctn"],
  ["sak", "zak", "sack"],
];

const ALIAS_BY_UNIT = new Map<string, string>();
for (const group of UNIT_ALIAS_GROUPS) {
  for (const unit of group) {
    ALIAS_BY_UNIT.set(unit, group[0]);
  }
}

export function normalizeUnit(value: string | null | undefined) {
  return (value ?? "").toLowerCase().trim().replace(/[^a-z]/g, "");
}

function canonicalUnit(value: string | null | undefined) {
  const normalized = normalizeUnit(value);
  return ALIAS_BY_UNIT.get(normalized) ?? normalized;
}

export function unitsAreSame(left: string | null | undefined, right: string | null | undefined) {
  const a = canonicalUnit(left);
  const b = canonicalUnit(right);
  return Boolean(a) && a === b;
}

/**
 * Menentukan apakah satuan yang disebut customer bisa dipakai apa adanya,
 * bisa dikonversi memakai data konversi resmi, atau harus ditanyakan ulang.
 *
 * Tidak pernah mengarang konversi: selama tidak ada baris konversi dari
 * database, satuan asing selalu menghasilkan NEEDS_CLARIFICATION.
 */
export function resolveUnit(input: {
  requestedUnit: string | null;
  inventoryUnit: string;
  quantity: number | null;
  conversions?: UnitConversion[];
}): UnitResolution {
  const requestedUnit = input.requestedUnit?.trim() ? input.requestedUnit.trim() : null;
  const inventoryUnit = input.inventoryUnit;
  const quantity = input.quantity;

  if (!requestedUnit) {
    return {
      status: "EXACT",
      requested_unit: null,
      inventory_unit: inventoryUnit,
      unit_match: true,
      conversion: null,
      quantity_in_inventory_unit: quantity,
      reason: "UNIT_NOT_SPECIFIED",
    };
  }

  if (unitsAreSame(requestedUnit, inventoryUnit)) {
    return {
      status: "EXACT",
      requested_unit: requestedUnit,
      inventory_unit: inventoryUnit,
      unit_match: true,
      conversion: null,
      quantity_in_inventory_unit: quantity,
      reason: "UNIT_MATCH",
    };
  }

  const conversion = (input.conversions ?? []).find(
    (item) =>
      unitsAreSame(item.from_unit, requestedUnit) && unitsAreSame(item.to_unit, inventoryUnit),
  );

  if (conversion && Number.isFinite(conversion.factor) && conversion.factor > 0) {
    return {
      status: "CONVERTIBLE",
      requested_unit: requestedUnit,
      inventory_unit: inventoryUnit,
      unit_match: true,
      conversion: { factor: conversion.factor, source: "database" },
      quantity_in_inventory_unit: quantity === null ? null : quantity * conversion.factor,
      reason: "UNIT_CONVERTED_FROM_DATABASE",
    };
  }

  return {
    status: "NEEDS_CLARIFICATION",
    requested_unit: requestedUnit,
    inventory_unit: inventoryUnit,
    unit_match: false,
    conversion: null,
    quantity_in_inventory_unit: null,
    reason: "UNIT_CONVERSION_UNAVAILABLE",
  };
}
