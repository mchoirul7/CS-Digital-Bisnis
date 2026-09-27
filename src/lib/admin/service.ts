import type {
  BusinessRepository,
  ConversationOwnership,
  HandoffStatus,
  HumanHandoff,
  Message,
} from "@/lib/business-tools/types";
import { HANDOFF_REASON_LABELS } from "@/lib/handoff";

export type AdminInboxItem = {
  handoff_id: string;
  conversation_id: string;
  session_id: string;
  ownership: ConversationOwnership;
  status: HandoffStatus;
  reason_code: string;
  reason_label: string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
  last_customer_message: string | null;
  active_product: string | null;
};

export type AdminInbox = {
  pending: AdminInboxItem[];
  active: AdminInboxItem[];
  done: AdminInboxItem[];
};

function activeProductName(metadata: Record<string, unknown>) {
  const value = metadata.active_product;

  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }

  return null;
}

function lastCustomerMessage(messages: Message[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      return messages[index].content;
    }
  }

  return null;
}

async function toInboxItem(
  repository: BusinessRepository,
  companyId: string,
  handoff: HumanHandoff,
): Promise<AdminInboxItem | null> {
  const conversation = await repository.getConversation(companyId, handoff.conversation_id);

  if (!conversation) {
    return null;
  }

  const messages = await repository.listMessages(conversation.id, 20);
  const metadata = handoff.metadata ?? {};

  return {
    handoff_id: handoff.id,
    conversation_id: conversation.id,
    session_id: conversation.session_id,
    ownership: conversation.ownership,
    status: handoff.status,
    reason_code: handoff.reason_code,
    reason_label: HANDOFF_REASON_LABELS[handoff.reason_code] ?? handoff.reason_code,
    summary: handoff.summary,
    metadata,
    created_at: handoff.created_at,
    claimed_at: handoff.claimed_at,
    resolved_at: handoff.resolved_at,
    last_customer_message: lastCustomerMessage(messages),
    active_product: activeProductName(metadata),
  };
}

/** Inbox admin: perlu ditangani, sedang ditangani, dan yang sudah selesai. */
export async function listAdminInbox(
  repository: BusinessRepository,
  companyId: string,
): Promise<AdminInbox> {
  const handoffs = await repository.listHandoffs(companyId, [
    "PENDING",
    "ACTIVE",
    "RESOLVED",
    "CLOSED",
  ]);

  const items = (
    await Promise.all(handoffs.map((handoff) => toInboxItem(repository, companyId, handoff)))
  ).filter((item): item is AdminInboxItem => item !== null);

  return {
    pending: items.filter((item) => item.status === "PENDING"),
    active: items.filter((item) => item.status === "ACTIVE"),
    done: items.filter((item) => item.status === "RESOLVED" || item.status === "CLOSED"),
  };
}

export type ClaimOutcome =
  | { ok: true; handoff: HumanHandoff }
  | { ok: false; reason: "ALREADY_CLAIMED" | "NOT_FOUND" };

/**
 * Klaim percakapan. Transisi PENDING -> ACTIVE dilakukan di database dengan
 * syarat status, sehingga kalau dua admin menekan tombol bersamaan hanya satu
 * yang berhasil.
 */
export async function claimConversation(
  repository: BusinessRepository,
  handoffId: string,
): Promise<ClaimOutcome> {
  const claimed = await repository.claimHandoff(handoffId);

  if (!claimed) {
    const existing = await repository.getHandoff(handoffId);
    return { ok: false, reason: existing ? "ALREADY_CLAIMED" : "NOT_FOUND" };
  }

  await repository.setConversationOwnership(claimed.conversation_id, "HUMAN_ACTIVE");
  return { ok: true, handoff: claimed };
}

export type AdminReplyOutcome =
  | { ok: true; message: Message }
  | { ok: false; reason: "NOT_HUMAN_ACTIVE" | "NOT_FOUND" | "EMPTY" };

/**
 * Balasan admin masuk ke percakapan apa adanya. AI tidak pernah menulis ulang
 * atau menyaring kalimat admin.
 */
export async function sendAdminMessage(
  repository: BusinessRepository,
  companyId: string,
  conversationId: string,
  text: string,
): Promise<AdminReplyOutcome> {
  const content = text.trim();

  if (!content) {
    return { ok: false, reason: "EMPTY" };
  }

  const conversation = await repository.getConversation(companyId, conversationId);

  if (!conversation) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  if (conversation.ownership !== "HUMAN_ACTIVE") {
    return { ok: false, reason: "NOT_HUMAN_ACTIVE" };
  }

  const message = await repository.addMessage(conversationId, "assistant", content, "ADMIN");
  return { ok: true, message };
}

export type CloseOutcome =
  | { ok: true; handoff: HumanHandoff; ownership: ConversationOwnership }
  | { ok: false; reason: "NOT_FOUND" };

/**
 * "Kembalikan ke AI" menyelesaikan handoff dan mengembalikan kepemilikan ke AI.
 * ConversationState tidak dihapus, jadi AI melanjutkan dengan konteks yang sama -
 * tetapi angka stok/harga tetap dibaca ulang dari database pada pesan berikutnya.
 */
export async function finishHandoff(
  repository: BusinessRepository,
  handoffId: string,
  mode: "RETURN_TO_AI" | "CLOSE",
): Promise<CloseOutcome> {
  const status = mode === "RETURN_TO_AI" ? "RESOLVED" : "CLOSED";
  const closed = await repository.closeHandoff(handoffId, status);

  if (!closed) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const ownership: ConversationOwnership = mode === "RETURN_TO_AI" ? "AI_ACTIVE" : "CLOSED";
  await repository.setConversationOwnership(closed.conversation_id, ownership);

  return { ok: true, handoff: closed, ownership };
}
