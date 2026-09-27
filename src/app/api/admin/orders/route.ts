import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeAdminRequest } from "@/lib/admin/auth";
import { getBusinessRepository } from "@/lib/business-tools/repository";
import { DEFAULT_COMPANY_ID } from "@/lib/company";

export const runtime = "nodejs";
const statusSchema = z.enum(["draft", "confirmed", "processing", "completed", "cancelled"]);

export async function GET(request: Request) {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const status = statusSchema.optional().safeParse(url.searchParams.get("status") || undefined);
  const offset = z.coerce.number().int().min(0).max(100000).safeParse(url.searchParams.get("offset") ?? 0);
  if ((id && !z.uuid().safeParse(id).success) || !status.success || !offset.success) {
    return NextResponse.json({ error: "Filter tidak valid." }, { status: 400 });
  }
  try {
    const repository = getBusinessRepository();
    if (id) {
      const order = await repository.getOrder(DEFAULT_COMPANY_ID, id);
      return order ? NextResponse.json({ order }) : NextResponse.json({ error: "Pesanan tidak ditemukan." }, { status: 404 });
    }
    return NextResponse.json({ orders: await repository.listOrders(DEFAULT_COMPANY_ID, status.data, offset.data) });
  } catch (error) {
    console.error("Read orders failed", error);
    return NextResponse.json({ error: "Pesanan belum bisa dibaca." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = authorizeAdminRequest(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const body = z.object({ orderId: z.uuid(), status: z.enum(["processing", "completed", "cancelled"]) })
    .strict().safeParse(await request.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Payload tidak valid." }, { status: 400 });
  try {
    const order = await getBusinessRepository().changeOrderStatus(DEFAULT_COMPANY_ID, body.data.orderId, body.data.status);
    return NextResponse.json({ order });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("ORDER_NOT_FOUND")) return NextResponse.json({ error: "Pesanan tidak ditemukan." }, { status: 404 });
    if (message.includes("INVALID_ORDER_TRANSITION")) return NextResponse.json({ error: "Status pesanan sudah berubah. Muat ulang pesanan." }, { status: 409 });
    console.error("Update order failed", error);
    return NextResponse.json({ error: "Status pesanan belum bisa diubah." }, { status: 500 });
  }
}
