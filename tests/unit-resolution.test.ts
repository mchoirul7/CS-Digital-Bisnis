import { describe, expect, it } from "vitest";
import { resolveUnit } from "@/lib/business/unit-resolver";
import { parseIndonesianNumber, validateQuantity } from "@/lib/business/validators";

describe("D. unit resolution", () => {
  it("satuan yang sama dengan database diterima apa adanya", () => {
    const result = resolveUnit({ requestedUnit: "dus", inventoryUnit: "dus", quantity: 80 });

    expect(result.status).toBe("EXACT");
    expect(result.unit_match).toBe(true);
    expect(result.quantity_in_inventory_unit).toBe(80);
  });

  it("perbedaan ejaan satuan bukan konversi", () => {
    expect(resolveUnit({ requestedUnit: "KG", inventoryUnit: "kilogram", quantity: 2 }).status).toBe(
      "EXACT",
    );
    expect(resolveUnit({ requestedUnit: "liter", inventoryUnit: "l", quantity: 2 }).status).toBe(
      "EXACT",
    );
  });

  it("satuan tanpa data konversi harus diklarifikasi, bukan ditebak", () => {
    const result = resolveUnit({ requestedUnit: "bungkus", inventoryUnit: "dus", quantity: 80 });

    expect(result.status).toBe("NEEDS_CLARIFICATION");
    expect(result.unit_match).toBe(false);
    expect(result.quantity_in_inventory_unit).toBeNull();
  });

  it("customer yang tidak menyebut satuan memakai satuan database", () => {
    const result = resolveUnit({ requestedUnit: null, inventoryUnit: "dus", quantity: 20 });

    expect(result.status).toBe("EXACT");
    expect(result.quantity_in_inventory_unit).toBe(20);
  });

  it("konversi hanya dipakai kalau datanya berasal dari database", () => {
    const result = resolveUnit({
      requestedUnit: "bungkus",
      inventoryUnit: "dus",
      quantity: 80,
      conversions: [
        {
          id: "c1",
          company_id: "c",
          product_id: "p",
          from_unit: "bungkus",
          to_unit: "dus",
          factor: 0.025,
        },
      ],
    });

    expect(result.status).toBe("CONVERTIBLE");
    expect(result.quantity_in_inventory_unit).toBe(2);
    expect(result.conversion?.source).toBe("database");
  });

  it("satuan yang berbeda dimensi tetap butuh klarifikasi", () => {
    expect(resolveUnit({ requestedUnit: "kg", inventoryUnit: "dus", quantity: 5 }).status).toBe(
      "NEEDS_CLARIFICATION",
    );
    expect(resolveUnit({ requestedUnit: "karton", inventoryUnit: "dus", quantity: 5 }).status).toBe(
      "NEEDS_CLARIFICATION",
    );
  });
});

describe("quantity validation", () => {
  it.each([
    [50, "VALID"],
    [57, "VALID"],
    [1, "VALID"],
    [0, "INVALID_QUANTITY"],
    [-5, "INVALID_QUANTITY"],
    [Number.NaN, "INVALID_QUANTITY"],
    [2_000_000, "INVALID_QUANTITY"],
  ])("jumlah %s menghasilkan %s", (quantity, status) => {
    expect(validateQuantity(quantity).status).toBe(status);
  });

  it("jumlah yang tidak disebut ditandai MISSING", () => {
    expect(validateQuantity(null).status).toBe("MISSING");
  });

  it("angka dalam kata bahasa Indonesia diparse deterministik", () => {
    expect(parseIndonesianNumber(["lima"])).toBe(5);
    expect(parseIndonesianNumber(["dua", "puluh"])).toBe(20);
    expect(parseIndonesianNumber(["seribu"])).toBe(1000);
    expect(parseIndonesianNumber(["dua", "ratus", "lima", "puluh"])).toBe(250);
    expect(parseIndonesianNumber(["tiga", "ribu"])).toBe(3000);
    expect(parseIndonesianNumber(["produk"])).toBeNull();
  });
});
