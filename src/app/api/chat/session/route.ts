import { NextResponse } from "next/server";
import { getBusinessRepository } from "@/lib/business-tools/repository";
import { DEFAULT_COMPANY_ID } from "@/lib/company";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();

    if (!isRecord(body)) {
      return NextResponse.json({ error: "Payload tidak valid." }, { status: 400 });
    }

    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim() : "";

    if (!sessionId) {
      return NextResponse.json({ error: "sessionId wajib dikirim." }, { status: 400 });
    }

    if (action !== "reset") {
      return NextResponse.json({ error: "Action tidak dikenal." }, { status: 400 });
    }

    const repository = getBusinessRepository();
    const conversation = await repository.resetConversationSession(DEFAULT_COMPANY_ID, sessionId);

    return NextResponse.json({
      conversationId: conversation.id,
      ownership: conversation.ownership,
      state: conversation.state,
      messages: [],
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Session belum bisa direset." }, { status: 500 });
  }
}
