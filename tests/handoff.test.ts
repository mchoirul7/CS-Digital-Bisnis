import { describe, expect, it } from "vitest";
import { claimConversation, finishHandoff, listAdminInbox, sendAdminMessage } from "@/lib/admin/service";
import { evaluateBusinessGuard } from "@/lib/business-guard";
import { handleChatMessage } from "@/lib/chat/service";
import { DEFAULT_COMPANY_ID } from "@/lib/company";
import {
  basketCatalog,
  createMutableBusinessRepository,
  defaultCatalog,
  INDOMIE_GORENG_ID,
  testPaymentAccounts,
  type MutableBusinessRepository,
  type ProductSeed,
} from "./helpers/mutable-repository";
import { sendChatTurn, type ChatTurn } from "./helpers/chat";
import type { BusinessResult } from "@/lib/business/types";

function conversation(catalog: ProductSeed[] = defaultCatalog) {
  const repository = createMutableBusinessRepository(catalog);
  const sessionId = `handoff-${crypto.randomUUID()}`;

  return {
    repository,
    sessionId,
    send(message: string): Promise<ChatTurn> {
      return sendChatTurn({ message, sessionId }, { repository, forceDeterministicAi: true });
    },
    raw(message: string) {
      return handleChatMessage({ message, sessionId }, { repository, forceDeterministicAi: true });
    },
  };
}

async function openHandoffFor(repository: MutableBusinessRepository, conversationId: string) {
  return repository.findOpenHandoff(conversationId);
}

describe("kapan percakapan diserahkan ke admin", () => {
  it("customer minta admin: handoff nyata dan percakapan menunggu admin", async () => {
    const chat = conversation();
    const result = await chat.send("admin dong");

    expect(result.debug.handoff.triggered).toBe(true);
    expect(result.debug.handoff.reason_code).toBe("CUSTOMER_REQUESTED_HUMAN");
    expect(result.debug.handoff.handoff_id).toBeTruthy();
    expect(result.ownership).toBe("HUMAN_PENDING");

    const stored = await openHandoffFor(chat.repository, result.conversationId);
    expect(stored?.status).toBe("PENDING");
    expect(stored?.summary.length).toBeGreaterThan(0);
  });

  it("permintaan harga khusus jumlah besar diserahkan ke admin", async () => {
    const chat = conversation();
    const result = await chat.send("500 dus bisa diskon?");

    expect(result.debug.handoff.triggered).toBe(true);
    expect(result.debug.handoff.reason_code).toBe("SPECIAL_PRICE_REQUEST");
    expect(result.reply).not.toMatch(/\d+\s?%/);
  });

  it("komplain barang belum sampai diserahkan ke admin", async () => {
    const chat = conversation();
    const result = await chat.send("kok barang saya belum sampai");

    expect(result.debug.audit.intent).toBe("COMPLAINT");
    expect(result.debug.handoff.reason_code).toBe("COMPLAINT");
    expect(result.debug.handoff.handoff_id).toBeTruthy();
  });

  it("pertanyaan stok biasa tidak pernah diserahkan ke admin", async () => {
    const chat = conversation();
    const result = await chat.send("indomie goreng stok berapa?");

    expect(result.debug.audit.status).toBe("STOCK_AVAILABLE");
    expect(result.debug.handoff.triggered).toBe(false);
    expect(result.ownership).toBe("AI_ACTIVE");
  });

  it("singkatan yang masih dipahami tidak memicu handoff", async () => {
    const chat = conversation();
    const result = await chat.send("indomie goreng msh ada gk");

    expect(result.debug.audit.resolved_product).toBe("Indomie Goreng");
    expect(result.debug.handoff.triggered).toBe(false);
  });

  it("produk yang tidak dikenali ditanyakan dulu, bukan langsung ke admin", async () => {
    const chat = conversation();
    const result = await chat.send("Kopi Kapal Api ada?");

    expect(result.debug.audit.status).toBe("PRODUCT_NOT_FOUND");
    expect(result.debug.handoff.triggered).toBe(false);
  });

  it("dua eskalasi berturut-turut tetap satu handoff terbuka", async () => {
    const chat = conversation();

    const first = await chat.send("admin dong");
    const second = await chat.send("500 dus bisa diskon?");

    expect(second.debug.handoff.handoff_id).toBe(first.debug.handoff.handoff_id);

    const all = await chat.repository.listHandoffs(DEFAULT_COMPANY_ID, ["PENDING", "ACTIVE"]);
    expect(all).toHaveLength(1);
  });
});

describe("admin takeover", () => {
  it("klaim memindahkan kepemilikan dan membungkam AI", async () => {
    const chat = conversation();
    const escalated = await chat.send("admin dong");
    const handoffId = escalated.debug.handoff.handoff_id as string;

    const claim = await claimConversation(chat.repository, handoffId);
    expect(claim.ok).toBe(true);

    const conversationRow = await chat.repository.getConversation(
      DEFAULT_COMPANY_ID,
      escalated.conversationId,
    );
    expect(conversationRow?.ownership).toBe("HUMAN_ACTIVE");

    const silent = await chat.raw("halo? jadi bisa gak?");
    expect(silent.reply).toBeNull();
    expect(silent.debug).toBeNull();
    expect(silent.ownership).toBe("HUMAN_ACTIVE");

    // Pesan customer tetap tersimpan supaya admin melihatnya.
    const messages = await chat.repository.listMessages(escalated.conversationId, 50);
    expect(messages.some((message) => message.content === "halo? jadi bisa gak?")).toBe(true);
    expect(messages.filter((message) => message.sender === "AI").at(-1)?.content).toBe(
      escalated.reply,
    );
  });

  it("hanya satu admin yang berhasil mengambil percakapan yang sama", async () => {
    const chat = conversation();
    const escalated = await chat.send("admin dong");
    const handoffId = escalated.debug.handoff.handoff_id as string;

    const [first, second] = await Promise.all([
      claimConversation(chat.repository, handoffId),
      claimConversation(chat.repository, handoffId),
    ]);

    const successes = [first, second].filter((outcome) => outcome.ok);
    expect(successes).toHaveLength(1);

    const failure = [first, second].find((outcome) => !outcome.ok);
    expect(failure && !failure.ok && failure.reason).toBe("ALREADY_CLAIMED");
  });

  it("balasan admin masuk ke percakapan apa adanya", async () => {
    const chat = conversation();
    const escalated = await chat.send("admin dong");
    await claimConversation(chat.repository, escalated.debug.handoff.handoff_id as string);

    const reply = await sendAdminMessage(
      chat.repository,
      DEFAULT_COMPANY_ID,
      escalated.conversationId,
      "Untuk harga dan pengiriman saya cek dulu ya, Kak.",
    );

    expect(reply.ok).toBe(true);
    expect(reply.ok && reply.message.sender).toBe("ADMIN");
    expect(reply.ok && reply.message.content).toBe(
      "Untuk harga dan pengiriman saya cek dulu ya, Kak.",
    );
  });

  it("admin tidak bisa membalas percakapan yang belum diambil", async () => {
    const chat = conversation();
    const escalated = await chat.send("admin dong");

    const reply = await sendAdminMessage(
      chat.repository,
      DEFAULT_COMPANY_ID,
      escalated.conversationId,
      "halo",
    );

    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.reason).toBe("NOT_HUMAN_ACTIVE");
  });

  it("dikembalikan ke AI: AI menjawab lagi dengan data terkini", async () => {
    const chat = conversation(basketCatalog);
    await chat.send("indomie goreng ada?");
    const escalated = await chat.send("admin dong");
    const handoffId = escalated.debug.handoff.handoff_id as string;

    await claimConversation(chat.repository, handoffId);
    await sendAdminMessage(
      chat.repository,
      DEFAULT_COMPANY_ID,
      escalated.conversationId,
      "Stok indomie kemarin 50 dus ya, Kak.",
    );

    const finished = await finishHandoff(chat.repository, handoffId, "RETURN_TO_AI");
    expect(finished.ok).toBe(true);
    expect(finished.ok && finished.ownership).toBe("AI_ACTIVE");

    // Stok berubah setelah admin mengetik angka lama di percakapan.
    chat.repository.setInventory(INDOMIE_GORENG_ID, 12);

    const resumed = await chat.send("stok indomie sekarang berapa?");

    expect(resumed.debug.audit.current_stock).toBe(12);
    expect(resumed.reply).toContain("12");
    expect(resumed.reply).not.toContain("50");
    expect(resumed.state.activeProduct?.name).toBe("Indomie Goreng");
  });

  it("diselesaikan: percakapan ditutup dan AI tidak melanjutkan sendiri", async () => {
    const chat = conversation();
    const escalated = await chat.send("admin dong");
    const handoffId = escalated.debug.handoff.handoff_id as string;

    await claimConversation(chat.repository, handoffId);
    const closed = await finishHandoff(chat.repository, handoffId, "CLOSE");

    expect(closed.ok && closed.ownership).toBe("CLOSED");

    const afterClose = await chat.raw("halo lagi");
    expect(afterClose.reply).toBeNull();
  });

  it("inbox admin mengelompokkan percakapan sesuai statusnya", async () => {
    const chat = conversation();
    const escalated = await chat.send("admin dong");

    const pendingInbox = await listAdminInbox(chat.repository, DEFAULT_COMPANY_ID);
    expect(pendingInbox.pending).toHaveLength(1);
    expect(pendingInbox.pending[0].last_customer_message).toBe("admin dong");
    expect(pendingInbox.pending[0].reason_label.length).toBeGreaterThan(0);

    await claimConversation(chat.repository, escalated.debug.handoff.handoff_id as string);

    const activeInbox = await listAdminInbox(chat.repository, DEFAULT_COMPANY_ID);
    expect(activeInbox.pending).toHaveLength(0);
    expect(activeInbox.active).toHaveLength(1);
  });
});

describe("business guard menahan klaim yang tidak terverifikasi", () => {
  function guard(response: string, result: BusinessResult) {
    return evaluateBusinessGuard({
      response,
      businessResult: result,
      officialPaymentAccounts: testPaymentAccounts,
    });
  }

  /** Beberapa check bisa memblokir sekaligus; yang diuji adalah check tertentu. */
  function blockedChecks(result: ReturnType<typeof guard>) {
    return result.checks.filter((check) => check.status === "blocked").map((check) => check.name);
  }

  it("menolak klaim pembayaran sudah diterima", async () => {
    const chat = conversation();
    const result = await chat.send("udah transfer");

    const blocked = guard("Pembayaran sudah kami terima, Kak.", result.debug.businessResult);
    expect(blocked.allowed).toBe(false);
    expect(blockedChecks(blocked)).toContain("payment_verification");

    // Yang benar-benar dikirim ke customer tidak pernah memuat klaim itu.
    expect(result.reply).not.toMatch(/sudah (kami|saya) terima/i);
  });

  it("menolak klaim pesanan sudah tercatat di sistem", async () => {
    const chat = conversation(basketCatalog);
    await chat.send("indomie goreng 2 dus");
    const review = await chat.send("udah itu aja");

    const blocked = guard("Pesanan sudah berhasil dibuat ya, Kak.", review.debug.businessResult);
    expect(blocked.allowed).toBe(false);
    expect(blockedChecks(blocked)).toContain("order_persistence");
  });

  it("menolak barang yang sudah dibatalkan diklaim masuk pesanan", async () => {
    const chat = conversation(basketCatalog);
    await chat.send("indomie goreng 2 dus");
    await chat.send("teh botol 3 dus");
    await chat.send("tehnya batal");
    const review = await chat.send("udah itu aja");

    const blocked = guard(
      "Jadi Indomie Goreng 2 dus dan Teh Botol 3 dus ya, Kak.",
      review.debug.businessResult,
    );

    expect(blocked.allowed).toBe(false);
    expect(blockedChecks(blocked)).toContain("draft_integrity");
  });

  it("menolak grand total yang tidak sesuai perhitungan", async () => {
    const chat = conversation(basketCatalog);
    await chat.send("indomie goreng 2 dus");
    const review = await chat.send("udah itu aja");

    const blocked = guard("Totalnya Rp999.000, Kak.", review.debug.businessResult);
    expect(blocked.allowed).toBe(false);
    expect(blockedChecks(blocked)).toContain("money_integrity");
  });
});
