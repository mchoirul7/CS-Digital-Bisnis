import type { QuantityValidation } from "./types";

const MAX_QUANTITY = 1_000_000;

const SIMPLE_NUMBER_WORDS = new Map<string, number>([
  ["nol", 0],
  ["kosong", 0],
  ["satu", 1],
  ["dua", 2],
  ["tiga", 3],
  ["empat", 4],
  ["lima", 5],
  ["enam", 6],
  ["tujuh", 7],
  ["delapan", 8],
  ["sembilan", 9],
  ["sepuluh", 10],
  ["sebelas", 11],
  ["seratus", 100],
  ["seribu", 1000],
]);

const MULTIPLIER_WORDS = new Map<string, number>([
  ["puluh", 10],
  ["belas", 1],
  ["ratus", 100],
  ["ribu", 1000],
  ["juta", 1_000_000],
]);

export function isNumberWord(token: string) {
  return SIMPLE_NUMBER_WORDS.has(token) || MULTIPLIER_WORDS.has(token);
}

/**
 * Parser angka bahasa Indonesia yang generik ("lima", "dua puluh", "seribu",
 * "dua ratus lima puluh"). Dipakai supaya jumlah yang diucapkan dengan kata
 * tetap divalidasi oleh business engine, bukan diterjemahkan oleh AI.
 */
export function parseIndonesianNumber(tokens: string[]): number | null {
  let total = 0;
  let section = 0;
  let pending = 0;
  let seen = false;

  for (const token of tokens) {
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      pending += Number(token);
      seen = true;
      continue;
    }

    const simple = SIMPLE_NUMBER_WORDS.get(token);
    if (simple !== undefined) {
      seen = true;

      if (token === "seribu") {
        total += 1000;
      } else if (token === "seratus") {
        section += 100;
      } else {
        pending += simple;
      }

      continue;
    }

    const multiplier = MULTIPLIER_WORDS.get(token);
    if (multiplier === undefined) {
      if (seen) {
        break;
      }
      continue;
    }

    seen = true;

    if (token === "belas") {
      section += (pending || 1) + 10;
      pending = 0;
      continue;
    }

    if (token === "ribu" || token === "juta") {
      total += (section + pending || 1) * multiplier;
      section = 0;
      pending = 0;
      continue;
    }

    section += (pending || 1) * multiplier;
    pending = 0;
  }

  if (!seen) {
    return null;
  }

  return total + section + pending;
}

/**
 * Validasi jumlah pesanan. Deterministic: nilai nol, negatif, bukan angka, atau
 * di luar batas wajar tidak pernah boleh lanjut ke kalkulasi.
 */
export function validateQuantity(quantity: number | null | undefined): QuantityValidation {
  if (quantity === null || quantity === undefined) {
    return { status: "MISSING", quantity: null, reason: "QUANTITY_NOT_PROVIDED" };
  }

  if (!Number.isFinite(quantity)) {
    return { status: "INVALID_QUANTITY", quantity: null, reason: "QUANTITY_NOT_A_NUMBER" };
  }

  if (quantity <= 0) {
    return { status: "INVALID_QUANTITY", quantity, reason: "QUANTITY_MUST_BE_POSITIVE" };
  }

  if (quantity > MAX_QUANTITY) {
    return { status: "INVALID_QUANTITY", quantity, reason: "QUANTITY_OUT_OF_RANGE" };
  }

  return { status: "VALID", quantity, reason: "QUANTITY_VALID" };
}
