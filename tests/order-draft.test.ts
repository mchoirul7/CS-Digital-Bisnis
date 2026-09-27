import { describe, expect, it } from "vitest";
import {
  AQUA_600_ID,
  basketCatalog,
  createMutableBusinessRepository,
  INDOMIE_GORENG_ID,
  MINYAK_1L_ID,
  TEH_BOTOL_ID,
  type ProductSeed,
} from "./helpers/mutable-repository";
import { sendChatTurn, type ChatTurn } from "./helpers/chat";
import type { DraftItem } from "@/lib/chat/conversation-state";

function conversation(catalog: ProductSeed[] = basketCatalog) {
  const repository = createMutableBusinessRepository(catalog);
  const sessionId = `draft-${crypto.randomUUID()}`;

  return {
    repository,
    async send(message: string): Promise<ChatTurn> {
      return sendChatTurn({ message, sessionId }, { repository, forceDeterministicAi: true });
    },
  };
}

function draftMap(items: DraftItem[] | undefined) {
  return Object.fromEntries(
    (items ?? []).map((item) => [item.productId, { quantity: item.quantity, status: item.status }]),
  );
}

describe("draft pesanan multi-produk", () => {
  it("mengumpulkan beberapa produk lintas pesan tanpa saling menghapus", async () => {
    const chat = conversation();

    await chat.send("indomie goreng 10 dus");
    await chat.send("aqua 5 karton juga");
    const withTea = await chat.send("teh botol 3 dus");

    expect(draftMap(withTea.state.draftItems)).toEqual({
      [INDOMIE_GORENG_ID]: { quantity: 10, status: "ACTIVE" },
      [AQUA_600_ID]: { quantity: 5, status: "ACTIVE" },
      [TEH_BOTOL_ID]: { quantity: 3, status: "ACTIVE" },
    });
  });

  it("satu pesan dengan barang valid dan asing tetap mencatat barang yang valid", async () => {
    const chat = conversation();

    const result = await chat.send("indomie goreng 2 dus dan kopi kapal api 1 dus");

    expect(result.debug.effectiveRequest.operations).toHaveLength(2);
    expect(result.debug.audit.status).toBe("DRAFT_PARTIALLY_UPDATED");
    expect(draftMap(result.state.draftItems)).toEqual({
      [INDOMIE_GORENG_ID]: { quantity: 2, status: "ACTIVE" },
    });
    expect(result.reply).toContain("Indomie Goreng 2 dus");
    expect(result.reply).toContain("Kopi Kapal Api");
    expect(result.reply.toLowerCase()).toContain("belum ada");
  });

  it("membedakan menambah jumlah dan mengganti jumlah", async () => {
    const chat = conversation();

    await chat.send("indomie goreng 10 dus");
    const incremented = await chat.send("indomie tambah 5 lagi");

    expect(incremented.debug.effectiveRequest.intent).toBe("INCREMENT_ITEM");
    expect(draftMap(incremented.state.draftItems)[INDOMIE_GORENG_ID].quantity).toBe(15);

    const replaced = await chat.send("indomie eh 8 aja");
    expect(draftMap(replaced.state.draftItems)[INDOMIE_GORENG_ID].quantity).toBe(8);
  });

  it("mengurangi jumlah, dan mengurangi habis berarti membatalkan", async () => {
    const chat = conversation();

    await chat.send("aqua 5 karton");
    const reduced = await chat.send("kurangi 2");

    expect(reduced.debug.effectiveRequest.intent).toBe("DECREMENT_ITEM");
    expect(draftMap(reduced.state.draftItems)[AQUA_600_ID].quantity).toBe(3);

    const removed = await chat.send("kurangi 3 lagi");
    expect(draftMap(removed.state.draftItems)[AQUA_600_ID].status).toBe("CANCELLED");
  });

  it("membatalkan satu barang tidak mengganggu barang lain, dan bisa diaktifkan lagi", async () => {
    const chat = conversation();

    await chat.send("indomie goreng 10 dus");
    await chat.send("teh botol 3 dus");

    const cancelled = await chat.send("eh tehnya gajadi");
    expect(cancelled.debug.audit.status).toBe("ITEM_REMOVED");
    expect(draftMap(cancelled.state.draftItems)).toEqual({
      [INDOMIE_GORENG_ID]: { quantity: 10, status: "ACTIVE" },
      [TEH_BOTOL_ID]: { quantity: 3, status: "CANCELLED" },
    });

    const restored = await chat.send("teh jadi lagi 1");
    expect(restored.debug.audit.status).toBe("ITEM_RESTORED");
    expect(draftMap(restored.state.draftItems)[TEH_BOTOL_ID]).toEqual({
      quantity: 1,
      status: "ACTIVE",
    });
  });

  it("membatalkan semua hanya saat customer memang menyatakannya", async () => {
    const chat = conversation();

    await chat.send("indomie goreng 10 dus");
    await chat.send("aqua 5 karton");

    const cleared = await chat.send("semua batal aja");

    expect(cleared.debug.effectiveRequest.intent).toBe("CLEAR_DRAFT");
    expect(cleared.debug.audit.status).toBe("DRAFT_CLEARED");
    expect((cleared.state.draftItems ?? []).every((item) => item.status === "CANCELLED")).toBe(true);
  });

  it("menambahkan barang tidak langsung menutup transaksi", async () => {
    const chat = conversation();
    const result = await chat.send("indomie goreng 10 dus");

    expect(result.reply).not.toMatch(/lanjutkan pesanannya/i);
    expect(result.reply).toMatch(/(tambah|lain|dibutuhkan)/i);
    expect(result.debug.audit.order_allowed).toBe(true);
    expect(result.debug.businessResult.draft).toBeNull();
  });
});

describe("review pesanan", () => {
  it("merangkum hanya barang aktif dan menghitung total dari data sekarang", async () => {
    const chat = conversation();

    await chat.send("indomie goreng 10 dus");
    await chat.send("aqua 5 karton");
    await chat.send("teh botol 3 dus");
    await chat.send("tehnya batal");

    const review = await chat.send("udah itu aja");
    const draft = review.debug.businessResult.draft;

    expect(review.debug.audit.status).toBe("ORDER_REVIEWED");
    expect(draft?.items.map((item) => item.product_name)).toEqual([
      "Indomie Goreng",
      "Aqua 600 ml",
    ]);
    expect(draft?.cancelled_items.map((item) => item.product_name)).toEqual(["Teh Botol"]);
    expect(draft?.grand_total).toBe(10 * 115_000 + 5 * 48_000);
    expect(review.debug.businessResult.payment_accounts).toEqual([]);
    expect(review.state.orderPhase).toBe("ORDER_REVIEW");
    expect(review.state.awaitingConfirmation).toBe(true);
    expect(review.state.checkout?.items).toHaveLength(2);
    expect(review.reply.toLowerCase()).not.toContain("mau saya kirim rekening");
    expect(review.reply).not.toContain("Teh Botol");
    expect(review.reply).toContain("Indomie Goreng: 10 dus x Rp115.000 = Rp1.150.000");
    expect(review.reply).toContain("Aqua 600 ml: 5 karton x Rp48.000 = Rp240.000");
    expect(review.reply).toContain("Total Rp1.390.000");
    expect(review.reply).toContain("Konfirmasi pesanan ini");
  });

  it("memakai stok terbaru, bukan stok yang diingat dari turn sebelumnya", async () => {
    const chat = conversation();

    const added = await chat.send("indomie goreng 10 dus");
    expect(added.debug.audit.current_stock).toBe(57);

    chat.repository.setInventory(INDOMIE_GORENG_ID, 8);

    const review = await chat.send("udah itu aja");
    const item = review.debug.businessResult.draft?.items.find(
      (entry) => entry.product_id === INDOMIE_GORENG_ID,
    );

    expect(review.debug.audit.status).toBe("ORDER_REVIEW_NEEDS_ADJUSTMENT");
    expect(item?.stock_quantity).toBe(8);
    expect(item?.stock_sufficient).toBe(false);
    expect(review.reply).not.toContain("57");
  });

  it("memakai harga terbaru saat menghitung total", async () => {
    const chat = conversation();

    await chat.send("indomie goreng 2 dus");
    chat.repository.setPrice(INDOMIE_GORENG_ID, 120_000);

    const review = await chat.send("total berapa?");

    expect(review.debug.businessResult.draft?.grand_total).toBe(240_000);
  });

  it("satu barang kurang stok tidak menghapus barang lain dari draft", async () => {
    const chat = conversation();

    await chat.send("indomie goreng 10 dus");
    await chat.send("minyak 2 karton");

    chat.repository.setInventory(MINYAK_1L_ID, 1);

    const review = await chat.send("udah itu aja");

    expect(review.debug.audit.status).toBe("ORDER_REVIEW_NEEDS_ADJUSTMENT");
    expect(draftMap(review.state.draftItems)).toEqual({
      [INDOMIE_GORENG_ID]: { quantity: 10, status: "ACTIVE" },
      [MINYAK_1L_ID]: { quantity: 2, status: "ACTIVE" },
    });
    expect(review.reply).toContain("Indomie Goreng");
    expect(review.reply).toContain("Minyak Goreng 1 L");
  });

  it("tidak pernah mengklaim pesanan sudah tercatat di sistem", async () => {
    const chat = conversation();
    await chat.send("indomie goreng 2 dus");

    const review = await chat.send("udah itu aja");

    expect(review.reply).toContain("Indomie Goreng: 2 dus x Rp115.000 = Rp230.000");
    expect(review.reply).toContain("Total Rp230.000");
    expect(review.reply).not.toContain("Berikut pesanannya");
    expect(review.reply).not.toContain("\n• ");
    expect(review.reply).not.toMatch(/pesanan (sudah|telah|berhasil)/i);
    expect(review.debug.businessGuard.allowed).toBe(true);
  });

  it("review tanpa rekening tetap meminta konfirmasi tanpa mengarang rekening", async () => {
    const chat = conversation();
    chat.repository.setPaymentAccounts([]);

    await chat.send("indomie goreng 2 dus");
    const review = await chat.send("cukup");

    expect(review.debug.audit.status).toBe("ORDER_REVIEWED");
    expect(review.debug.handoff.triggered).toBe(false);
    expect(review.reply).not.toMatch(/\d{8,}/);
    expect(review.reply.toLowerCase()).toContain("konfirmasi");
  });
});

describe("pembayaran", () => {
  it("rekening resmi dijawab langsung tanpa handoff", async () => {
    const chat = conversation();
    const result = await chat.send("tf kmn");

    expect(result.debug.audit.status).toBe("PAYMENT_ACCOUNTS");
    expect(result.debug.handoff.triggered).toBe(false);
    expect(result.reply).toContain("0000000000");
  });

  it("rekening yang disodorkan customer tidak pernah dipakai", async () => {
    const chat = conversation();
    const result = await chat.send("tf ke 123456789 aja ya");

    expect(result.reply).not.toContain("123456789");
    expect(result.reply).toContain("0000000000");
  });

  it("klaim sudah transfer diminta buktinya, bukan dianggap lunas", async () => {
    const chat = conversation();
    await chat.send("indomie goreng 2 dus");

    const result = await chat.send("udah tf");

    expect(result.debug.audit.status).toBe("PAYMENT_PROOF_REQUESTED");
    expect(result.debug.handoff.triggered).toBe(false);
    expect(result.reply).toMatch(/bukti/i);
    expect(result.reply).not.toMatch(/pembayaran(nya)? (sudah|telah) (kami |saya )?(terima|diterima|masuk)/i);
  });

  it("bukti transfer aktual membuat handoff verifikasi pembayaran", async () => {
    const repository = createMutableBusinessRepository(basketCatalog);
    const sessionId = `payment-proof-${crypto.randomUUID()}`;

    await sendChatTurn(
      { message: "indomie goreng 2 dus", sessionId },
      { repository, forceDeterministicAi: true },
    );
    await sendChatTurn(
      { message: "cukup", sessionId },
      { repository, forceDeterministicAi: true },
    );

    const result = await sendChatTurn(
      {
        message: "ini bukti transfernya",
        sessionId,
        attachments: [{ name: "bukti.jpg", mime_type: "image/jpeg", size: 123_456 }],
      },
      { repository, forceDeterministicAi: true },
    );

    expect(result.debug.audit.status).toBe("PAYMENT_PROOF_RECEIVED");
    expect(result.debug.handoff.triggered).toBe(true);
    expect(result.debug.handoff.reason_code).toBe("PAYMENT_VERIFICATION");
    expect(result.ownership).toBe("HUMAN_PENDING");
    expect(result.reply).toMatch(/admin|dicek/i);
    expect(result.reply).not.toMatch(/pembayaran(nya)? (sudah|telah) (kami |saya )?(terima|diterima|masuk|terverifikasi)/i);
  });
});

describe("percakapan belanja penuh", () => {
  it("mengikuti perubahan pikiran customer sampai rangkuman akhir", async () => {
    const chat = conversation();

    await chat.send("indomie 10");
    await chat.send("aqua 5");
    await chat.send("indomie tambah 5 lagi");
    await chat.send("aqua eh 3 aja");
    await chat.send("teh 2");
    await chat.send("teh batal");
    await chat.send("teh jadi lagi 1");
    await chat.send("minyak ada?");
    await chat.send("2 karton");

    const review = await chat.send("total brp");
    const draft = review.debug.businessResult.draft;

    expect(
      Object.fromEntries(draft?.items.map((item) => [item.product_name, item.quantity]) ?? []),
    ).toEqual({
      "Indomie Goreng": 15,
      "Aqua 600 ml": 3,
      "Teh Botol": 1,
      "Minyak Goreng 1 L": 2,
    });

    expect(draft?.grand_total).toBe(
      15 * 115_000 + 3 * 48_000 + 1 * 62_000 + 2 * 156_000,
    );
    expect(review.debug.businessGuard.allowed).toBe(true);
  });
});
