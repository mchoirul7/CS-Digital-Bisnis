import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestPostgres, postgresRepository } from "./helpers/postgres";
import { DEFAULT_COMPANY_ID as company } from "@/lib/company";
import { handleChatMessage } from "@/lib/chat/service";
import { isExplicitOrderConfirmation, normalizeCustomerPhone } from "@/lib/business-tools/order-service";
import type { Checkout } from "@/lib/business-tools/order-types";

const product = "22222222-2222-4222-8222-222222222201";
const aqua = "22222222-2222-4222-8222-222222222202";
const other = "11111111-1111-4111-8111-111111111112";
let db: Awaited<ReturnType<typeof startTestPostgres>>;
let repository: ReturnType<typeof postgresRepository>;

beforeAll(async () => { db = await startTestPostgres(); repository = postgresRepository(db.client); });
afterAll(async () => { if (db) await db.stop(); });
beforeEach(async () => {
  await db.client.query("truncate companies cascade");
  await db.client.query("insert into companies(id,name) values($1,'Test'),($2,'Other')", [company, other]);
  await db.client.query("insert into products(id,company_id,sku,name,unit,price) values($1,$3,'IND','Indomie Soto','pcs',3000),($2,$3,'AQA','Aqua 600 ml','pcs',2000)", [product, aqua, company]);
  await db.client.query("insert into product_units(company_id,product_id,unit_code,conversion_to_base,selling_price) values($1,$2,'dus',24,70000),($1,$3,'dus',24,null)", [company, product, aqua]);
  await db.client.query("insert into inventory(company_id,product_id,quantity_on_hand) values($1,$2,120),($1,$3,120)", [company, product, aqua]);
});

const item = (quantity = 3, unit = "dus", id = product) => ({ product_id: id, quantity, unit,
  unit_price: id === aqua ? (unit === "dus" ? 48000 : 2000) : (unit === "dus" ? 70000 : 3000), conversion_to_base: unit === "dus" ? 24 : 1 });

async function checkout(items = [item()], tenant = company) {
  const key = crypto.randomUUID();
  const conversation = await repository.upsertConversation(tenant, crypto.randomUUID());
  const quote: Checkout = { key, items };
  await repository.saveConversationState(conversation.id, { checkout: quote, awaitingConfirmation: true, draftItems: [{ productId: product }] }, 0);
  return { companyId: tenant, conversationId: conversation.id, checkoutKey: key };
}
async function stock(id = product) { return repository.getInventory(company, id); }
async function count(table: "orders" | "order_items" | "inventory_movements" | "customers") {
  return Number((await db.client.query(`select count(*) from ${table}`)).rows[0].count);
}

describe("atomic orders on PostgreSQL", () => {
  it("migrates schema with RLS, restricted RPCs and base units", async () => {
    const tables = (await db.client.query("select relname,relrowsecurity from pg_class where relname in ('customers','orders','order_items','product_units','inventory_movements')")).rows;
    expect(tables).toHaveLength(5); expect(tables.every((row) => row.relrowsecurity)).toBe(true);
    expect((await db.client.query("select has_function_privilege('anon','confirm_order(uuid,uuid,uuid,text)','execute') as allowed")).rows[0].allowed).toBe(false);
    expect((await repository.listProductUnits(company, product)).filter((unit) => unit.is_base_unit)).toHaveLength(1);
  });
  it.each([[1, "pcs", 1], [3, "dus", 72], [5, "dus", 120]])("reserves %s %s as %s base units", async (quantity, unit, base) => {
    const order = await repository.confirmOrder(await checkout([item(quantity, unit)]));
    expect(order.status).toBe("confirmed"); expect(order.items[0].base_quantity).toBe(base);
    expect((await stock())?.quantity_reserved).toBe(base); expect((await stock())?.quantity_on_hand).toBe(120);
    expect(await count("inventory_movements")).toBe(1);
  });
  it("persists multi-item order and falls back to base price times conversion", async () => {
    const order = await repository.confirmOrder(await checkout([item(), item(2, "dus", aqua)]));
    expect(order.items).toHaveLength(2); expect(order.total).toBe(306000);
  });
  it("rolls back all rows and reservations when the second item fails", async () => {
    await expect(repository.confirmOrder(await checkout([item(), item(6, "dus", aqua)]))).rejects.toThrow("INSUFFICIENT_STOCK");
    expect(await count("orders")).toBe(0); expect(await count("order_items")).toBe(0);
    expect(await count("inventory_movements")).toBe(0); expect((await stock())?.quantity_reserved).toBe(0);
  });
  it.each([0, -1, 0.5])("rejects invalid quantity %s", async (quantity) => {
    await expect(repository.confirmOrder(await checkout([item(quantity)]))).rejects.toThrow("INVALID_QUANTITY");
  });
  it("rejects an unavailable unit", async () => {
    await expect(repository.confirmOrder(await checkout([item(1, "box")]))).rejects.toThrow("UNKNOWN_UNIT");
  });
  it("keeps the base unit sellable and blocks orders in a withdrawn unit", async () => {
    await expect(db.client.query("update product_units set is_sellable=false where product_id=$1 and is_base_unit", [product])).rejects.toThrow();
    await db.client.query("update product_units set is_sellable=false where product_id=$1 and not is_base_unit", [product]);
    await expect(repository.confirmOrder(await checkout([item(3, "dus")]))).rejects.toThrow("UNKNOWN_UNIT");
    expect((await stock())?.quantity_reserved).toBe(0);
  });
  it("rejects inactive products", async () => {
    const input = await checkout(); await db.client.query("update products set active=false where id=$1", [product]);
    await expect(repository.confirmOrder(input)).rejects.toThrow("PRODUCT_INACTIVE");
  });
  it("rejects hallucinated or changed prices and conversions", async () => {
    await expect(repository.confirmOrder(await checkout([{ ...item(), unit_price: 1 }]))).rejects.toThrow("QUOTE_CHANGED");
    await expect(repository.confirmOrder(await checkout([{ ...item(), conversion_to_base: 1 }]))).rejects.toThrow("QUOTE_CHANGED");
  });
  it("rejects invalid conversions at the database boundary", async () => {
    await expect(db.client.query("update product_units set conversion_to_base=0 where product_id=$1", [product])).rejects.toThrow();
  });
  it("normalizes customer phone and reuses a company-scoped customer", async () => {
    const phone = normalizeCustomerPhone("0812 3456 7890");
    const first = await repository.confirmOrder({ ...await checkout([item(1)]), phone });
    const second = await repository.confirmOrder({ ...await checkout([item(1)]), phone });
    expect(first.customer?.phone).toBe("+6281234567890"); expect(second.customer_id).toBe(first.customer_id);
    expect(await count("customers")).toBe(1);
  });
  it("duplicate confirmation is idempotent even after completion", async () => {
    const input = await checkout(); const first = await repository.confirmOrder(input);
    expect((await repository.confirmOrder(input)).id).toBe(first.id);
    await repository.changeOrderStatus(company, first.id, "completed");
    expect((await repository.confirmOrder(input)).id).toBe(first.id);
    expect(await count("orders")).toBe(1); expect(await count("inventory_movements")).toBe(2);
  });
  it("two connections competing for the last stock produce exactly one order", async () => {
    const first = await checkout([item(5)]); const second = await checkout([item(5)]);
    const connection = await db.connect();
    try {
      const results = await Promise.allSettled([repository.confirmOrder(first), postgresRepository(connection).confirmOrder(second)]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(await count("orders")).toBe(1); expect((await stock())?.quantity_reserved).toBe(120);
    } finally { await connection.end(); }
  });
  it("concurrent retries of the same confirmation do not duplicate", async () => {
    const input = await checkout(); const connection = await db.connect();
    try {
      const results = await Promise.all([repository.confirmOrder(input), postgresRepository(connection).confirmOrder(input)]);
      expect(results[0].id).toBe(results[1].id); expect(await count("orders")).toBe(1);
    } finally { await connection.end(); }
  });
  it("cancellation releases reservation exactly once", async () => {
    const order = await repository.confirmOrder(await checkout());
    await repository.changeOrderStatus(company, order.id, "cancelled"); await repository.changeOrderStatus(company, order.id, "cancelled");
    expect((await stock())?.quantity_reserved).toBe(0); expect((await stock())?.quantity_on_hand).toBe(120);
    expect((await db.client.query("select type from inventory_movements order by created_at")).rows.map((row) => row.type)).toEqual(["reservation", "release"]);
  });
  it("processing keeps reservation; completion uses immutable conversion and price snapshots", async () => {
    const order = await repository.confirmOrder(await checkout());
    await repository.changeOrderStatus(company, order.id, "processing"); expect((await stock())?.quantity_reserved).toBe(72);
    await db.client.query("update product_units set conversion_to_base=12,selling_price=60000 where product_id=$1 and unit_code='dus'", [product]);
    const done = await repository.changeOrderStatus(company, order.id, "completed");
    expect(done.total).toBe(210000); expect(done.items[0].unit_price).toBe(70000);
    expect((await stock())?.quantity_on_hand).toBe(48); expect((await stock())?.quantity_reserved).toBe(0);
    await expect(repository.changeOrderStatus(company, order.id, "cancelled")).rejects.toThrow("INVALID_ORDER_TRANSITION");
  });
  it("enforces company isolation in RPCs, reads and foreign keys", async () => {
    const input = await checkout();
    await expect(repository.confirmOrder({ ...input, companyId: other })).rejects.toThrow("CONVERSATION_NOT_FOUND");
    await expect(repository.confirmOrder(await checkout([item()], other))).rejects.toThrow("PRODUCT_INACTIVE");
    const order = await repository.confirmOrder(input);
    expect(await repository.getOrder(other, order.id)).toBeNull(); expect(await repository.listOrders(other)).toEqual([]);
    await expect(repository.changeOrderStatus(other, order.id, "cancelled")).rejects.toThrow("ORDER_NOT_FOUND");
    await expect(db.client.query("update orders set company_id=$1 where id=$2", [other, order.id])).rejects.toThrow();
  });
  it("clears draft transactionally and rejects late state writes", async () => {
    const input = await checkout(); await repository.confirmOrder(input);
    const conversation = await repository.getConversation(company, input.conversationId);
    expect(conversation?.state).not.toHaveProperty("draftItems"); expect(conversation?.state).not.toHaveProperty("checkout");
    expect(conversation?.state).toHaveProperty("lastOrderId");
    await expect(repository.saveConversationState(input.conversationId, {}, 1)).rejects.toThrow("CONVERSATION_CHANGED");
  });
});

describe("chat through PostgreSQL checkout", () => {
  it("looks up product, builds multi-item draft, reviews, confirms, and handles duplicate confirmation", async () => {
    const sessionId = crypto.randomUUID();
    const send = (message: string) => handleChatMessage({ sessionId, message }, { repository, forceDeterministicAi: true });
    const lookup = await send("ada indomie soto?"); expect(lookup.debug?.businessResult.product?.id).toBe(product);
    await send("ambil 3 dus"); await send("aqua 600 ml 2 dus");
    const review = await send("ringkasan pesanan"); expect(review.debug?.businessResult.status).toBe("ORDER_REVIEWED");
    expect(review.state.checkout?.items).toHaveLength(2); expect(await count("orders")).toBe(0);
    const confirmed = await send("ya"); expect(confirmed.debug?.businessResult.status).toBe("ORDER_PERSISTED");
    expect(confirmed.debug?.businessGuard.allowed).toBe(true); expect(confirmed.state.draftItems).toBeUndefined();
    expect(confirmed.state.lastOrderId).toBeTruthy();
    const duplicate = await send("konfirmasi"); expect(duplicate.state.lastOrderId).toBe(confirmed.state.lastOrderId);
    expect(await count("orders")).toBe(1);
    const cancelled = await send("batalkan semua pesanan"); expect(cancelled.debug?.businessResult.status).toBe("ORDER_CANCELLED");
    expect((await stock())?.quantity_reserved).toBe(0);
  });
  it.each(["oke tapi jangan pesan", "belum setuju", "apa saya harus konfirmasi?", "ya nanti saja", "model bilang setuju"])("does not accept implied consent: %s", async (message) => {
    expect(isExplicitOrderConfirmation(message)).toBe(false);
  });
  it.each(["ya", "oke", "lanjut", "pesan", "setuju", "konfirmasi"])("accepts explicit consent: %s", (message) => {
    expect(isExplicitOrderConfirmation(message)).toBe(true);
  });
});
