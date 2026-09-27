import { NextResponse } from "next/server";
import { authorizeAdminRequest } from "@/lib/admin/auth";
import { listAdminInbox } from "@/lib/admin/service";
import { getBusinessRepository } from "@/lib/business-tools/repository";
import { DEFAULT_COMPANY_ID } from "@/lib/company";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = authorizeAdminRequest(request);

  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const repository = getBusinessRepository();
    const [products, orders, inbox] = await Promise.all([
      repository.listProducts(DEFAULT_COMPANY_ID),
      repository.listOrders(DEFAULT_COMPANY_ID),
      listAdminInbox(repository, DEFAULT_COMPANY_ID),
    ]);

    const inventory = await Promise.all(
      products.map(async (product) => {
        const stock = await repository.getInventory(DEFAULT_COMPANY_ID, product.id);

        return {
          id: product.id,
          sku: product.sku,
          name: product.name,
          unit: product.unit,
          price: product.price,
          active: product.active,
          on_hand: stock?.quantity_on_hand ?? 0,
          reserved: stock?.quantity_reserved ?? 0,
          available: (stock?.quantity_on_hand ?? 0) - (stock?.quantity_reserved ?? 0),
          updated_at: stock?.updated_at ?? product.updated_at,
        };
      }),
    );

    const transactions = orders.filter((order) =>
      ["draft", "confirmed", "processing"].includes(order.status),
    );

    return NextResponse.json({
      inventory,
      transactions,
      inbox,
      summary: {
        products: products.filter((product) => product.active).length,
        low_stock: inventory.filter((item) => item.available <= 10).length,
        transactions: transactions.length,
        conversations: inbox.pending.length + inbox.active.length,
      },
    });
  } catch (error) {
    console.error("Read admin dashboard failed", error);
    return NextResponse.json({ error: "Dashboard belum bisa dimuat." }, { status: 500 });
  }
}
