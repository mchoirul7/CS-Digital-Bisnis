import { describe, expect, it } from "vitest";
import { sendChatTurn } from "./helpers/chat";
import {
  createMutableBusinessRepository,
  defaultCatalog,
  type ProductSeed,
} from "./helpers/mutable-repository";

const INTERNAL_LANGUAGE =
  /(GREETING_RESPONSE|THANKS_RESPONSE|PRODUCT_LISTED|INSUFFICIENT_STOCK|READY_FOR_CONFIRMATION|PRODUCT_NOT_FOUND|PRODUCT_AMBIGUOUS|NEEDS_CLARIFICATION|FUZZY_SAFE|DATA_UNAVAILABLE|QUOTE_CREATED|STOCK_AVAILABLE|business_result|order_allowed|supabase|gemini|database|SKU|confidence|tool)/i;

const ROBOTIC_LANGUAGE =
  /(permintaan anda tidak dapat diproses|tidak ditemukan dalam database|terjadi ketidaksesuaian|silakan menentukan pilihan|telah diterima oleh sistem)/i;

function sentences(reply: string) {
  return reply.split(/[.!?]+\s/).filter((part) => part.trim().length > 0);
}

function apologies(reply: string) {
  return (reply.match(/\bmaaf\b/gi) ?? []).length;
}

/**
 * Kualitas percakapan diuji terpisah dari kebenaran fakta: jawaban harus ringkas,
 * ramah, dan bebas istilah internal, apa pun status bisnisnya.
 */
function expectConversationalQuality(reply: string) {
  expect(reply.length).toBeLessThanOrEqual(320);
  expect(sentences(reply).length).toBeLessThanOrEqual(4);
  expect(apologies(reply)).toBeLessThanOrEqual(1);
  expect(reply).not.toMatch(INTERNAL_LANGUAGE);
  expect(reply).not.toMatch(ROBOTIC_LANGUAGE);
  expect(reply).not.toMatch(/[{}[\]<>]|\bnull\b|\btrue\b|\bfalse\b/);
  expect(reply.trim()).toBe(reply);
}

function conversation(catalog: ProductSeed[] = defaultCatalog) {
  const repository = createMutableBusinessRepository(catalog);
  const sessionId = `humanization-${crypto.randomUUID()}`;

  return {
    repository,
    async send(message: string) {
      return sendChatTurn({ message, sessionId }, { repository, forceDeterministicAi: true });
    },
  };
}

describe("kualitas percakapan", () => {
  it.each([
    ["indomie ada gak?"],
    ["gan stok indomie?"],
    ["Pak, apakah Indomie masih tersedia?"],
    ["butuh 80 dus nih buat besok"],
    ["80 bungkus bisa?"],
    ["kalau saya ambil semua gimana?"],
    ["mahal amat, diskon dong"],
    ["transfer mana?"],
    ["kok barang saya belum datang?"],
    ["indomie soto ada?"],
    ["jual apa saja?"],
    ["makasih ya"],
    ["halo"],
  ])("%s dijawab natural dan tidak kaku", async (message) => {
    const chat = conversation();
    await chat.send("Indomie goreng ada?");
    const result = await chat.send(message);

    expectConversationalQuality(result.reply);
    expect(result.debug.businessGuard.allowed).toBe(true);
  });

  it("gaya santai dijawab ringkas dengan fakta database", async () => {
    const result = await conversation().send("gan indomie masih ada gak?");

    expect(result.reply).toContain("57 dus");
    expect(result.reply).toMatch(/kak/i);
    expectConversationalQuality(result.reply);
  });

  it("kebutuhan mendesak diakui tanpa mengubah fakta", async () => {
    const chat = conversation();
    await chat.send("Indomie goreng ada?");
    const result = await chat.send("butuh 80 dus nih buat besok");

    expect(result.debug.audit.status).toBe("INSUFFICIENT_STOCK");
    expect(result.debug.audit.order_allowed).toBe(false);
    expect(result.reply).toMatch(/mendesak/i);
    expect(result.reply).toContain("57 dus");
    expectConversationalQuality(result.reply);
  });

  it("klarifikasi satuan ditanyakan dengan ramah", async () => {
    const chat = conversation();
    await chat.send("Indomie goreng ada?");
    const result = await chat.send("80 bungkus bisa?");

    expect(result.debug.audit.status).toBe("NEEDS_CLARIFICATION");
    expect(result.reply).toMatch(/maksudnya/i);
    expect(result.reply).toContain("80 bungkus");
    expect(result.reply).toContain("80 dus");
    expectConversationalQuality(result.reply);
  });

  it("percakapan berlanjut tanpa mengulang dari nol", async () => {
    const chat = conversation();
    await chat.send("Indomie masih ada?");
    const second = await chat.send("20 dus deh");

    expect(second.debug.audit.resolved_product).toBe("Indomie Goreng");
    expect(second.debug.audit.status).toBe("READY_FOR_CONFIRMATION");
    expect(second.reply).toContain("Indomie Goreng 20 dus");
    expectConversationalQuality(second.reply);
  });
});
