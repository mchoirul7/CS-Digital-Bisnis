import { NextResponse } from "next/server";
import { getBusinessRepository } from "@/lib/business-tools/repository";
import { DEFAULT_COMPANY_ID } from "@/lib/company";

export const runtime = "nodejs";

/**
 * Dipakai customer UI untuk menarik pesan baru (termasuk balasan admin) dan
 * status kepemilikan percakapan. Polling sederhana; belum perlu realtime.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();

  if (!sessionId) {
    return NextResponse.json({ error: "sessionId wajib dikirim." }, { status: 400 });
  }

  try {
    const repository = getBusinessRepository();
    const conversation = await repository.upsertConversation(DEFAULT_COMPANY_ID, sessionId);
    const messages = await repository.listMessages(conversation.id, 50);

    return NextResponse.json({
      conversationId: conversation.id,
      ownership: conversation.ownership,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        sender: message.sender,
        content: message.content,
        created_at: message.created_at,
      })),
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Tidak bisa membaca percakapan." }, { status: 500 });
  }
}
