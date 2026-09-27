import { describe, expect, it } from "vitest";
import { handleChatMessage } from "@/lib/chat/service";
import {
  AQUA_600_ID,
  createMutableBusinessRepository,
  defaultCatalog,
  INDOMIE_GORENG_ID,
  multiVariantCatalog,
  type MutableBusinessRepository,
  type ProductSeed,
} from "./helpers/mutable-repository";
import { sendChatTurn, type ChatTurn } from "./helpers/chat";

/**
 * Setiap pesan dikirim sebagai request terpisah dengan sessionId yang sama,
 * persis seperti UI: tidak ada konteks yang dibawa client.
 */
function conversation(catalog: ProductSeed[] = defaultCatalog) {
  const repository = createMutableBusinessRepository(catalog);
  const sessionId = `ctx-${crypto.randomUUID()}`;

  return {
    repository,
    sessionId,
    async send(message: string): Promise<ChatTurn> {
      return sendChatTurn({ message, sessionId }, { repository, forceDeterministicAi: true });
    },
  };
}

describe("product entity bukan kalimat", () => {
  it("pertanyaan harga tidak ikut masuk ke nama produk", async () => {
    const chat = conversation();
    const result = await chat.send("indomie goreng brp?");

    expect(result.debug.effectiveRequest.product_query).toBe("indomie goreng");
    expect(result.debug.audit.resolved_product).toBe("Indomie Goreng");
    expect(result.debug.audit.status).toBe("PRICE_AVAILABLE");
  });

  it("pertanyaan isi kemasan dan eceran tidak mencemari nama produk", async () => {
    const chat = conversation();
    const result = await chat.send("indomie goreng 1 dus isi brp? bisa beli eceran?");

    expect(result.debug.effectiveRequest.product_query).toBe("indomie goreng");
    expect(result.debug.audit.resolved_product).toBe("Indomie Goreng");
    expect(result.debug.audit.status).toBe("PACKAGING_DATA_UNAVAILABLE");
    expect(result.debug.audit.secondary_intents).toContain("RETAIL_AVAILABILITY");
  });

  it("spesifikasi varian tidak ikut dibuang", async () => {
    const chat = conversation(multiVariantCatalog);
    const result = await chat.send("indomie soto ada?");

    expect(result.debug.effectiveRequest.product_query).toBe("indomie soto");
    expect(result.debug.audit.resolved_product).toBe("Indomie Soto");
  });

  it("ukuran varian tetap dipertahankan", async () => {
    const chat = conversation();
    const result = await chat.send("aqua 600 ml ada?");

    expect(result.debug.effectiveRequest.product_query).toContain("600");
    expect(result.debug.audit.resolved_product).toBe("Aqua 600 ml");
  });
});

describe("konteks percakapan", () => {
  it("kapabilitas yang gagal tidak menghapus produk yang sudah dikenali", async () => {
    const chat = conversation();

    const first = await chat.send("indomie goreng 1 dus isi brp? bisa beli eceran?");
    expect(first.state.activeProduct?.name).toBe("Indomie Goreng");

    const second = await chat.send("kalau ambil 5 dus berapa?");

    expect(second.debug.contextResolution.product_source).toBe("CONVERSATION_STATE");
    expect(second.debug.audit.resolved_product).toBe("Indomie Goreng");
    expect(second.debug.effectiveRequest.quantity).toBe(5);
    expect(second.debug.effectiveRequest.unit).toBe("dus");
    expect(second.debug.audit.status).toBe("QUOTE_CREATED");
    expect(second.debug.audit.total).toBe(575_000);
  });

  it("pertanyaan elliptical mewarisi produk yang sedang dibahas", async () => {
    const chat = conversation();
    await chat.send("indomie goreng ada?");

    const price = await chat.send("berapa?");
    expect(price.debug.audit.resolved_product).toBe("Indomie Goreng");
    expect(price.debug.audit.price).toBe(115_000);

    const stock = await chat.send("stoknya cukup?");
    expect(stock.debug.audit.resolved_product).toBe("Indomie Goreng");
    expect(stock.debug.audit.current_stock).toBe(57);
  });

  it("produk eksplisit mengalahkan konteks", async () => {
    const chat = conversation();
    await chat.send("indomie goreng ada?");

    const switched = await chat.send("kalau aqua?");
    expect(switched.debug.contextResolution.product_source).toBe("EXPLICIT_MESSAGE");
    expect(switched.state.activeProduct?.id).toBe(AQUA_600_ID);

    const followUp = await chat.send("berapa?");
    expect(followUp.debug.audit.resolved_product).toBe("Aqua 600 ml");
    expect(followUp.debug.audit.price).toBe(48_000);
  });

  it("produk ambigu disimpan sebagai kandidat dan dijawab dari kandidat itu", async () => {
    const chat = conversation(multiVariantCatalog);

    const ambiguous = await chat.send("indomie ada?");
    expect(ambiguous.debug.audit.status).toBe("PRODUCT_AMBIGUOUS");
    expect(ambiguous.state.pendingCandidates?.length).toBeGreaterThan(1);
    expect(ambiguous.state.awaitingClarification).toBe(true);

    const answered = await chat.send("yang kari ayam");
    expect(answered.debug.contextResolution.product_source).toBe("PENDING_CANDIDATE");
    expect(answered.debug.audit.resolved_product).toBe("Indomie Kari Ayam");
    expect(answered.state.pendingCandidates).toBeUndefined();
    expect(answered.state.activeProduct?.name).toBe("Indomie Kari Ayam");
  });

  it("produk tidak ditemukan tidak menimpa produk aktif", async () => {
    const chat = conversation();
    await chat.send("indomie goreng ada?");

    const unknown = await chat.send("Kopi Kapal Api ada?");
    expect(unknown.debug.audit.status).toBe("PRODUCT_NOT_FOUND");
    expect(unknown.state.activeProduct?.id).toBe(INDOMIE_GORENG_ID);
  });

  it("kembali ke produk yang pernah dibahas walau namanya ambigu", async () => {
    const chat = conversation(multiVariantCatalog);
    await chat.send("indomie goreng ada?");
    await chat.send("kalau aqua?");

    const back = await chat.send("balik indomie");

    expect(back.debug.audit.resolved_product).toBe("Indomie Goreng");
    expect(back.state.activeProduct?.id).toBe(INDOMIE_GORENG_ID);
  });
});

describe("kontrak conversation id", () => {
  it("seluruh pesan pada satu sesi memakai conversation id yang sama", async () => {
    const chat = conversation();

    const first = await chat.send("indomie goreng ada?");
    const second = await chat.send("berapa?");
    const third = await chat.send("stoknya cukup?");

    expect(second.conversationId).toBe(first.conversationId);
    expect(third.conversationId).toBe(first.conversationId);
  });

  it("sesi baru memulai percakapan dan konteks baru", async () => {
    const repository: MutableBusinessRepository = createMutableBusinessRepository(defaultCatalog);

    const first = await sendChatTurn(
      { message: "indomie goreng ada?", sessionId: "session-a" },
      { repository, forceDeterministicAi: true },
    );

    const fresh = await sendChatTurn(
      { message: "berapa?", sessionId: "session-b" },
      { repository, forceDeterministicAi: true },
    );

    expect(fresh.conversationId).not.toBe(first.conversationId);
    expect(fresh.state.activeProduct).toBeUndefined();
    expect(fresh.debug.audit.resolved_product).toBeNull();
  });

  it("konteks hidup di server, bukan dikirim client", async () => {
    const chat = conversation();
    await chat.send("indomie goreng ada?");

    // Request berikutnya hanya membawa pesan dan sessionId - tidak ada context
    // maupun history dari client, persis seperti pemanggilan HTTP terpisah.
    const result = await handleChatMessage(
      { message: "berapa?", sessionId: chat.sessionId },
      { repository: chat.repository, forceDeterministicAi: true },
    );

    expect(result.debug?.audit.resolved_product).toBe("Indomie Goreng");
  });
});
