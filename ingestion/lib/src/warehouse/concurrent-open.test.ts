import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { postgresWarehouse, type Connection } from "#src/warehouse/index.ts";

// PGlite has one connection, so it cannot race. These tests need a Postgres server and skip
// without one, as the orchestration tests do.
const SERVER = ["WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD", "WAREHOUSE_DB"] as const;

function serverConfig(): pg.ClientConfig | string {
  const missing = SERVER.filter((name) => process.env[name] === undefined);
  if (missing.length > 0) return `set ${missing.join(", ")} to a Postgres server, as .env.example does`;
  const env = process.env;
  return {
    host: env.WAREHOUSE_HOST,
    port: Number(env.WAREHOUSE_PORT),
    user: env.WAREHOUSE_USER,
    password: env.WAREHOUSE_PASSWORD,
    database: env.WAREHOUSE_DB,
  };
}

async function connect(config: pg.ClientConfig): Promise<Connection> {
  const client = new pg.Client(config);
  await client.connect();
  return {
    query: <R>(text: string, params?: unknown[]) => client.query<R & pg.QueryResultRow>(text, params),
    drizzle: () => drizzle(client),
    close: () => client.end(),
  };
}

test("warehouses that open at once on an empty schema all succeed", async (t) => {
  const config = serverConfig();
  if (typeof config === "string") return t.skip(config);
  let admin: Connection;
  try {
    admin = await connect(config);
  } catch (error) {
    return t.skip(`no Postgres server at ${config.host}:${config.port}: ${String(error)}`);
  }
  t.after(() => admin.close());

  for (let round = 0; round < 10; round++) {
    const schema = `race_${round}_${randomBytes(4).toString("hex")}`;
    const warehouse = postgresWarehouse({ schema, connect: () => connect(config) });
    const results = await Promise.allSettled(["source_0", "source_1", "source_2"].map((table) => warehouse.open(table)));
    try {
      for (const result of results) if (result.status === "fulfilled") await result.value.close();
    } finally {
      await admin.query(`drop schema if exists "${schema}" cascade`);
    }
    const failed = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));
    assert.deepEqual(failed, [], `round ${round}`);
  }
});
