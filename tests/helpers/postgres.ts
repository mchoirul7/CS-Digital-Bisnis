import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Client, types } from "pg";
import type { BusinessRepository } from "@/lib/business-tools/types";
import type { OrderDetail } from "@/lib/business-tools/order-types";
import { createMutableBusinessRepository } from "./mutable-repository";

types.setTypeParser(1700, Number);
types.setTypeParser(1184, (value) => new Date(value).toISOString());

export async function startTestPostgres() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const directory = await mkdtemp(join(tmpdir(), "order-automation-pg-"));
  const database = new EmbeddedPostgres({ databaseDir: join(directory, "data"), port, user: "postgres",
    password: "local-test-only", persistent: false, onLog: () => {}, onError: () => {},
    initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-h", "127.0.0.1"] });
  await database.initialise();
  await database.start();
  const connect = async () => {
    const client = new Client({ host: "127.0.0.1", port, database: "postgres", user: "postgres", password: "local-test-only" });
    await client.connect(); return client;
  };
  const client = await connect();
  await client.query("create role anon; create role authenticated; create role service_role bypassrls;");
  const migrations = (await readdir("supabase/migrations")).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    const sql = await readFile(join("supabase/migrations", migration), "utf8");
    if (sql.trim()) await client.query(sql);
  }
  return { client, connect, stop: async () => { await client.end(); await database.stop(); } };
}

export function postgresRepository(client: Client): BusinessRepository {
  const fallback = createMutableBusinessRepository();
  async function getOrder(company: string, id: string): Promise<OrderDetail | null> {
    const order = (await client.query("select * from orders where company_id=$1 and id=$2", [company, id])).rows[0];
    if (!order) return null;
    return { ...order, items: (await client.query("select * from order_items where company_id=$1 and order_id=$2 order by product_id", [company, id])).rows,
      customer: order.customer_id ? (await client.query("select * from customers where company_id=$1 and id=$2", [company, order.customer_id])).rows[0] : null };
  }
  return { ...fallback,
    async getCompany(id) { return (await client.query("select * from companies where id=$1", [id])).rows[0] ?? null; },
    async listProducts(company) { return (await client.query("select * from products where company_id=$1 and active", [company])).rows; },
    async listActiveProducts(company, limit, offset) { return (await client.query("select * from products where company_id=$1 and active order by name limit $2 offset $3", [company, limit, offset])).rows; },
    async getProduct(company, id) { return (await client.query("select * from products where company_id=$1 and id=$2 and active", [company, id])).rows[0] ?? null; },
    async getInventory(company, id) { return (await client.query("select * from inventory where company_id=$1 and product_id=$2", [company, id])).rows[0] ?? null; },
    async listProductUnits(company, id) { return (await client.query("select * from product_units where company_id=$1 and product_id=$2 order by is_base_unit desc", [company, id])).rows; },
    async upsertConversation(company, session) {
      return (await client.query("insert into conversations(company_id,session_id) values($1,$2) on conflict(company_id,session_id) do update set session_id=excluded.session_id returning *", [company, session])).rows[0];
    },
    async getConversation(company, id) { return (await client.query("select * from conversations where company_id=$1 and id=$2", [company, id])).rows[0] ?? null; },
    async saveConversationState(id, state, version) {
      const result = await client.query("update conversations set state=$2, state_version=state_version+1 where id=$1 and ($3::integer is null or state_version=$3)", [id, state, version]);
      if (!result.rowCount) throw new Error("CONVERSATION_CHANGED");
    },
    async confirmOrder(input) {
      const row = (await client.query("select confirm_order($1,$2,$3,$4) as id", [input.companyId, input.conversationId, input.checkoutKey, input.phone ?? null])).rows[0];
      return (await getOrder(input.companyId, row.id))!;
    },
    getOrder,
    async listOrders(company, status, offset = 0) { return (await client.query("select * from orders where company_id=$1 and ($2::text is null or status=$2) order by created_at desc limit 50 offset $3", [company, status, offset])).rows; },
    async changeOrderStatus(company, id, status) {
      await client.query("select change_order_status($1,$2,$3)", [company, id, status]);
      return (await getOrder(company, id))!;
    },
    async recordBusinessAudit(input) {
      for (const guard of input.guards) await client.query("insert into business_guard_logs(company_id,conversation_id,guard_type,action,reason) values($1,$2,$3,$4,$5)", [input.companyId, input.conversationId, guard.type, guard.action, guard.reason]);
    },
  };
}
