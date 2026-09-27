import type { BusinessResult } from "@/lib/business/types";
import type {
  BusinessRepository,
  ConversationOwnership,
  HandoffReasonCode,
  HumanHandoff,
} from "@/lib/business-tools/types";
import { formatRupiah } from "@/lib/utils/format";

export type HandoffDecision = {
  required: boolean;
  reason_code: HandoffReasonCode | null;
  /** Alasan internal yang stabil; bukan kalimat untuk customer. */
  reason: string;
};

export const NO_HANDOFF: HandoffDecision = {
  required: false,
  reason_code: null,
  reason: "NO_HANDOFF_REQUIRED",
};

export function handoffDecision(
  reasonCode: HandoffReasonCode,
  reason: string,
): HandoffDecision {
  return { required: true, reason_code: reasonCode, reason };
}

/** Label reason untuk admin inbox. Bukan untuk customer. */
export const HANDOFF_REASON_LABELS: Record<HandoffReasonCode, string> = {
  AI_UNCERTAIN: "AI belum yakin memahami permintaan",
  CUSTOMER_REQUESTED_HUMAN: "Customer minta bicara dengan admin",
  PRODUCT_AMBIGUOUS_UNRESOLVED: "Produk masih ambigu setelah klarifikasi",
  SPECIAL_PRICE_REQUEST: "Permintaan harga khusus",
  DISCOUNT_REQUEST: "Permintaan diskon",
  DELIVERY_UNVERIFIED: "Kepastian pengiriman belum bisa diverifikasi",
  PAYMENT_ISSUE: "Kendala pembayaran",
  PAYMENT_VERIFICATION: "Bukti transfer perlu diverifikasi",
  COMPLAINT: "Komplain customer",
  ORDER_EXCEPTION: "Pengecualian pesanan",
  BUSINESS_DATA_UNAVAILABLE: "Data bisnis tidak bisa dibaca",
  UNSAFE_RESPONSE_BLOCKED: "Jawaban AI diblokir business guard",
  OUT_OF_SCOPE: "Di luar cakupan AI",
  OTHER: "Lainnya",
};

function quantityText(result: BusinessResult) {
  const quantity = result.requested.quantity;

  if (quantity === null) {
    return null;
  }

  const unit = result.requested.unit ?? result.product?.unit ?? "unit";
  return `${quantity} ${unit}`;
}

/**
 * Ringkasan untuk admin. Bahasanya template, tetapi setiap angka di dalamnya
 * berasal dari BusinessResult yang sudah diverifikasi - bukan dari model bahasa
 * dan bukan dari ingatan percakapan.
 */
export function buildHandoffSummary(input: {
  reasonCode: HandoffReasonCode;
  customerMessage: string;
  result: BusinessResult;
}): string {
  const { reasonCode, result } = input;
  const product = result.product?.name ?? result.requested.product_query ?? null;
  const quantity = quantityText(result);

  const subject = [product, quantity ? `sebanyak ${quantity}` : null].filter(Boolean).join(" ");

  const facts: string[] = [];

  if (result.availability) {
    facts.push(`stok saat ini ${result.availability.quantity} ${result.availability.unit}`);
  }

  if (result.price !== null) {
    facts.push(`harga terdaftar ${formatRupiah(result.price)} per ${result.product?.unit ?? "unit"}`);
  }

  if (result.total !== null) {
    facts.push(`total terhitung ${formatRupiah(result.total)}`);
  }

  const factText = facts.length > 0 ? ` Data saat eskalasi: ${facts.join(", ")}.` : "";

  const headline = (() => {
    switch (reasonCode) {
      case "CUSTOMER_REQUESTED_HUMAN":
        return "Customer minta dihubungkan dengan admin.";
      case "SPECIAL_PRICE_REQUEST":
        return `Customer meminta harga khusus${subject ? ` untuk ${subject}` : ""}. Sistem tidak punya aturan harga khusus.`;
      case "DISCOUNT_REQUEST":
        return `Customer meminta diskon${subject ? ` untuk ${subject}` : ""}. Sistem tidak punya aturan diskon.`;
      case "DELIVERY_UNVERIFIED":
        return "Customer butuh kepastian jadwal pengiriman, sedangkan kemampuan pengiriman belum terdata di sistem.";
      case "PAYMENT_ISSUE":
        return "Customer melaporkan kendala pembayaran yang tidak bisa diverifikasi otomatis.";
      case "PAYMENT_VERIFICATION":
        return "Customer mengirim bukti transfer. Sistem tidak punya verifikasi pembayaran otomatis, jadi keabsahannya perlu dicek manusia.";
      case "COMPLAINT":
        return "Customer menyampaikan komplain yang belum punya alur otomatis.";
      case "ORDER_EXCEPTION":
        return `Pesanan${subject ? ` ${subject}` : ""} tidak bisa diproses otomatis.`;
      case "PRODUCT_AMBIGUOUS_UNRESOLVED":
        return "Produk yang dimaksud customer masih belum jelas setelah klarifikasi.";
      case "BUSINESS_DATA_UNAVAILABLE":
        return "Data bisnis tidak bisa dibaca saat customer bertanya, jadi tidak ada angka yang bisa dijawab.";
      case "UNSAFE_RESPONSE_BLOCKED":
        return "Jawaban AI diblokir business guard karena tidak sesuai fakta, jadi percakapan dialihkan ke admin.";
      case "AI_UNCERTAIN":
        return "AI belum berhasil memahami maksud customer setelah beberapa kali mencoba.";
      case "OUT_OF_SCOPE":
        return "Permintaan customer di luar cakupan yang bisa dijawab AI.";
      default:
        return "Percakapan perlu ditangani admin.";
    }
  })();

  const customerNeed = input.customerMessage.trim().slice(0, 300);

  return `${headline}${factText} Pesan terakhir customer: "${customerNeed}".`;
}

export function buildHandoffMetadata(result: BusinessResult) {
  return {
    active_product: result.product ? { id: result.product.id, name: result.product.name } : null,
    requested_product_query: result.requested.product_query,
    requested_quantity: result.requested.quantity,
    requested_unit: result.requested.unit,
    last_intent: result.intent,
    business_status: result.status,
    business_reason: result.reason,
    current_stock: result.availability,
    price: result.price,
    total: result.total,
    urgency: result.urgency,
  } satisfies Record<string, unknown>;
}

export type EnsureHandoffResult = {
  handoff: HumanHandoff;
  created: boolean;
  ownershipBefore: ConversationOwnership;
  ownershipAfter: ConversationOwnership;
};

/**
 * Membuat handoff nyata, idempotent. Kalau percakapan sudah punya handoff yang
 * belum selesai, handoff itu yang dipakai ulang - tidak pernah menumpuk.
 * Ownership hanya naik ke HUMAN_PENDING dari AI_ACTIVE; percakapan yang sudah
 * HUMAN_ACTIVE tidak diturunkan kembali.
 */
export async function ensureHandoff(input: {
  repository: BusinessRepository;
  conversationId: string;
  ownership: ConversationOwnership;
  reasonCode: HandoffReasonCode;
  reason: string;
  summary: string;
  metadata: Record<string, unknown>;
}): Promise<EnsureHandoffResult> {
  const existing = await input.repository.findOpenHandoff(input.conversationId);

  const handoff =
    existing ??
    (await input.repository.createHandoff({
      conversationId: input.conversationId,
      reason: input.reason,
      reasonCode: input.reasonCode,
      summary: input.summary,
      metadata: input.metadata,
    }));

  let ownershipAfter = input.ownership;

  if (input.ownership === "AI_ACTIVE" || input.ownership === "CLOSED") {
    ownershipAfter = handoff.status === "ACTIVE" ? "HUMAN_ACTIVE" : "HUMAN_PENDING";
    await input.repository.setConversationOwnership(input.conversationId, ownershipAfter);
  }

  return {
    handoff,
    created: !existing,
    ownershipBefore: input.ownership,
    ownershipAfter,
  };
}
