import { NextResponse } from "next/server";
import {
  claimConversation,
  finishHandoff,
  listAdminInbox,
  sendAdminMessage,
} from "@/lib/admin/service";
import { authorizeAdminRequest } from "@/lib/admin/auth";
import { getBusinessRepository } from "@/lib/business-tools/repository";
import { DEFAULT_COMPANY_ID } from "@/lib/company";

export const runtime = "nodejs";

const MAX_REPLY_LENGTH = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function GET(request: Request) {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const url = new URL(request.url);
  const conversationId = url.searchParams.get("conversationId")?.trim();

  try {
    const repository = getBusinessRepository();

    if (conversationId) {
      const conversation = await repository.getConversation(DEFAULT_COMPANY_ID, conversationId);

      if (!conversation) {
        return NextResponse.json({ error: "Percakapan tidak ditemukan." }, { status: 404 });
      }

      const messages = await repository.listMessages(conversation.id, 100);

      return NextResponse.json({
        conversation: {
          id: conversation.id,
          session_id: conversation.session_id,
          ownership: conversation.ownership,
        },
        messages: messages.map((message) => ({
          id: message.id,
          role: message.role,
          sender: message.sender,
          content: message.content,
          created_at: message.created_at,
        })),
      });
    }

    const inbox = await listAdminInbox(repository, DEFAULT_COMPANY_ID);
    return NextResponse.json(inbox);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Tidak bisa membaca inbox admin." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body: unknown = await request.json();

    if (!isRecord(body)) {
      return NextResponse.json({ error: "Payload tidak valid." }, { status: 400 });
    }

    const repository = getBusinessRepository();
    const action = typeof body.action === "string" ? body.action : "";
    const handoffId = typeof body.handoffId === "string" ? body.handoffId : "";
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";

    if (action === "claim") {
      const outcome = await claimConversation(repository, handoffId);

      if (!outcome.ok) {
        // Admin lain sudah mengambil duluan; ini kondisi normal, bukan error server.
        return NextResponse.json(
          { ok: false, reason: outcome.reason },
          { status: outcome.reason === "NOT_FOUND" ? 404 : 409 },
        );
      }

      return NextResponse.json({ ok: true, handoff: outcome.handoff });
    }

    if (action === "reply") {
      const text = typeof body.text === "string" ? body.text.slice(0, MAX_REPLY_LENGTH) : "";
      const outcome = await sendAdminMessage(repository, DEFAULT_COMPANY_ID, conversationId, text);

      if (!outcome.ok) {
        return NextResponse.json(
          { ok: false, reason: outcome.reason },
          { status: outcome.reason === "NOT_FOUND" ? 404 : 409 },
        );
      }

      return NextResponse.json({ ok: true, message: outcome.message });
    }

    if (action === "return_to_ai" || action === "close") {
      const outcome = await finishHandoff(
        repository,
        handoffId,
        action === "return_to_ai" ? "RETURN_TO_AI" : "CLOSE",
      );

      if (!outcome.ok) {
        return NextResponse.json({ ok: false, reason: outcome.reason }, { status: 404 });
      }

      return NextResponse.json({ ok: true, ownership: outcome.ownership });
    }

    return NextResponse.json({ error: "Action tidak dikenal." }, { status: 400 });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Aksi admin gagal." }, { status: 500 });
  }
}
