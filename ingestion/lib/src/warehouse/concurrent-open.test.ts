import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { postgresWarehouse, type Connection } from "#src/warehouse/index.ts";

// PGlite has one connection, so it cannot race. These tests need a Postgres server and skip
// without one, as the orchestration tests do, except in CI, where a failed connection fails them. Like those, they work in a database of their own,
// dropped afterwards, so they read and write nothing of the warehouse's.
const SERVER = ["WAREHOUSE_HOST", "WAREHOUSE_PORT", "WAREHOUSE_USER", "WAREHOUSE_PASSWORD"] as const;

function serverConfig(): pg.ClientConfig | string {
  const missing = SERVER.filter((name) => process.env[name] === undefined);
  if (missing.length > 0) return `set ${missing.join(", ")} to a Postgres server, as .env.example does`;
  const env = process.env;
  return {
    host: env.WAREHOUSE_HOST,
    port: Number(env.WAREHOUSE_PORT),
    user: env.WAREHOUSE_USER,
    password: env.WAREHOUSE_PASSWORD,
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
  const server = serverConfig();
  if (typeof server === "string") return t.skip(server);
  let admin: Connection;
  try {
    admin = await connect({ ...server, database: "postgres" });
  } catch (error) {
    // CI starts a Postgres for this test, so there a failed connection is a failure, not a missing server.
    if (process.env.CI) throw error;
    return t.skip(`no Postgres server at ${server.host}:${server.port}: ${String(error)}`);
  }
  const database = `bj_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database "${database}"`);
  t.after(async () => {
    await admin.query(`drop database "${database}" with (force)`);
    await admin.close();
  });
  const scratch = { ...server, database };

  for (let round = 0; round < 10; round++) {
    const warehouse = postgresWarehouse({ schema: `race_${round}`, connect: () => connect(scratch) });
    const results = await Promise.allSettled(["source_0", "source_1", "source_2"].map((table) => warehouse.open(table)));
    for (const result of results) if (result.status === "fulfilled") await result.value.close();
    const failed = results.filter((r) => r.status === "rejected").map((r) => String(r.reason));
    assert.deepEqual(failed, [], `round ${round}`);
  }
});
