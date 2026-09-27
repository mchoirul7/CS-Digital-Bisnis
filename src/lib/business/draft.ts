import type { DraftItem } from "@/lib/chat/conversation-state";
import type { BusinessIntent } from "./types";

/**
 * Mutasi draft pesanan. Semuanya deterministik: model bahasa hanya boleh
 * mengusulkan aksinya, perubahan datanya dikerjakan di sini.
 */
export type DraftMutation =
  | { kind: "SET"; quantity: number }
  | { kind: "INCREMENT"; quantity: number }
  | { kind: "DECREMENT"; quantity: number }
  | { kind: "REMOVE" }
  | { kind: "RESTORE"; quantity: number | null }
  | { kind: "CLEAR" };

export type DraftMutationResult = {
  items: DraftItem[];
  changed: DraftItem | null;
  outcome: "ADDED" | "UPDATED" | "REMOVED" | "RESTORED" | "CLEARED" | "NO_TARGET" | "INVALID_QUANTITY";
};

export function activeItems(items: DraftItem[] | undefined) {
  return (items ?? []).filter((item) => item.status === "ACTIVE");
}

export function cancelledItems(items: DraftItem[] | undefined) {
  return (items ?? []).filter((item) => item.status === "CANCELLED");
}

export function findDraftItem(items: DraftItem[] | undefined, productId: string) {
  return (items ?? []).find((item) => item.productId === productId) ?? null;
}

export function mutationForIntent(
  intent: BusinessIntent,
  quantity: number | null,
): DraftMutation | null {
  switch (intent) {
    case "ORDER_REQUEST":
    case "SET_ITEM_QUANTITY":
      return quantity === null ? null : { kind: "SET", quantity };
    case "INCREMENT_ITEM":
      return quantity === null ? null : { kind: "INCREMENT", quantity };
    case "DECREMENT_ITEM":
      return quantity === null ? null : { kind: "DECREMENT", quantity };
    case "REMOVE_ITEM":
      return { kind: "REMOVE" };
    case "RESTORE_ITEM":
      return { kind: "RESTORE", quantity };
    case "CLEAR_DRAFT":
      return { kind: "CLEAR" };
    default:
      return null;
  }
}

const MAX_DRAFT_QUANTITY = 1_000_000;

/**
 * Menjalankan satu mutasi pada draft. Item yang dibatalkan tidak dihapus supaya
 * customer masih bisa mengaktifkannya kembali ("eh teh tadi jadi deh").
 */
export function applyDraftMutation(input: {
  items: DraftItem[] | undefined;
  mutation: DraftMutation;
  product: { id: string; name: string } | null;
  unit: string;
  timestamp?: string;
}): DraftMutationResult {
  const items = (input.items ?? []).map((item) => ({ ...item }));
  const updatedAt = input.timestamp ?? new Date().toISOString();

  if (input.mutation.kind === "CLEAR") {
    const cleared = items.map((item) => ({ ...item, status: "CANCELLED" as const, updatedAt }));
    return { items: cleared, changed: null, outcome: "CLEARED" };
  }

  if (!input.product) {
    return { items, changed: null, outcome: "NO_TARGET" };
  }

  const existing = items.find((item) => item.productId === input.product?.id) ?? null;

  if (input.mutation.kind === "REMOVE") {
    if (!existing) {
      return { items, changed: null, outcome: "NO_TARGET" };
    }

    existing.status = "CANCELLED";
    existing.updatedAt = updatedAt;
    return { items, changed: existing, outcome: "REMOVED" };
  }

  if (input.mutation.kind === "RESTORE") {
    if (!existing) {
      return { items, changed: null, outcome: "NO_TARGET" };
    }

    existing.status = "ACTIVE";
    if (input.mutation.quantity !== null) {
      existing.quantity = input.mutation.quantity;
    }
    existing.unit = input.unit || existing.unit;
    existing.updatedAt = updatedAt;
    return { items, changed: existing, outcome: "RESTORED" };
  }

  const current = existing && existing.status === "ACTIVE" ? existing.quantity : 0;

  const nextQuantity =
    input.mutation.kind === "SET"
      ? input.mutation.quantity
      : input.mutation.kind === "INCREMENT"
        ? current + input.mutation.quantity
        : current - input.mutation.quantity;

  if (!Number.isFinite(nextQuantity) || nextQuantity > MAX_DRAFT_QUANTITY) {
    return { items, changed: null, outcome: "INVALID_QUANTITY" };
  }

  // Mengurangi sampai nol sama dengan membatalkan barisnya.
  if (nextQuantity <= 0) {
    if (!existing) {
      return { items, changed: null, outcome: "INVALID_QUANTITY" };
    }

    existing.status = "CANCELLED";
    existing.updatedAt = updatedAt;
    return { items, changed: existing, outcome: "REMOVED" };
  }

  if (existing) {
    const wasActive = existing.status === "ACTIVE";
    existing.quantity = nextQuantity;
    existing.unit = input.unit || existing.unit;
    existing.status = "ACTIVE";
    existing.updatedAt = updatedAt;
    return { items, changed: existing, outcome: wasActive ? "UPDATED" : "RESTORED" };
  }

  const created: DraftItem = {
    productId: input.product.id,
    productName: input.product.name,
    quantity: nextQuantity,
    unit: input.unit,
    status: "ACTIVE",
    updatedAt,
  };

  items.push(created);
  return { items, changed: created, outcome: "ADDED" };
}
