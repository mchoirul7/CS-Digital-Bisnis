import { NextResponse } from "next/server";
import { handleChatMessage } from "@/lib/chat/service";
import { normalizeCustomerPhone } from "@/lib/business-tools/order-service";

export const runtime = "nodejs";

const MAX_MESSAGE_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Saat business data tidak bisa dibaca, jawabannya menyatakan datanya belum bisa
 * dicek - tidak pernah menebak angka.
 */
function businessDataFallback() {
  return "Sebentar ya, Kak. Datanya belum berhasil saya cek saat ini. Daripada saya kasih angka yang belum pasti, lebih aman saya bantu konfirmasikan ke admin.";
}

function parseAttachments(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      name: typeof item.name === "string" ? item.name.slice(0, 200) : "attachment",
      mime_type: typeof item.mime_type === "string" ? item.mime_type.slice(0, 120) : "application/octet-stream",
      size: typeof item.size === "number" && Number.isFinite(item.size) ? Math.max(0, item.size) : 0,
    }))
    .slice(0, 5);
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();

    if (!isRecord(body)) {
      return NextResponse.json({ error: "Payload tidak valid." }, { status: 400 });
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";

    if (!message) {
      return NextResponse.json({ error: "Pesan tidak boleh kosong." }, { status: 400 });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return NextResponse.json({ error: "Pesan terlalu panjang." }, { status: 400 });
    }

    // Konteks percakapan hidup di server, dikunci ke sessionId. Client tidak
    // lagi mengirim context, jadi konteks tidak bisa hilang atau dipalsukan.
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId wajib dikirim." }, { status: 400 });
    }

    let customerPhone: string | null;
    try {
      customerPhone = normalizeCustomerPhone(typeof body.customerPhone === "string" ? body.customerPhone : null);
    } catch {
      return NextResponse.json({ error: "Nomor telepon tidak valid." }, { status: 400 });
    }
    const result = await handleChatMessage({
      customerPhone,
      message,
      sessionId,
      attachments: parseAttachments(body.attachments),
    });

    const shouldExposeDebug =
      process.env.NODE_ENV !== "production" || process.env.ENABLE_DEBUG_PANEL === "true";

    return NextResponse.json({
      reply: result.reply,
      conversationId: result.conversationId,
      ownership: result.ownership,
      state: result.state,
      debug: shouldExposeDebug ? result.debug : undefined,
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({
      reply: businessDataFallback(),
      ownership: "AI_ACTIVE",
      state: {},
    });
  }
}
