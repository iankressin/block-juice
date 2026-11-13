import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { postgresWarehouse, type Connection } from "#src/warehouse/index.ts";
import { inputEvidence } from "#src/warehouse/input-evidence.ts";

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

  const warehouse = postgresWarehouse({ schema: "singleflight", connect: () => connect(scratch) });
  const first = await warehouse.open("shared_source");
  let opened = false;
  const waiting = warehouse.open("shared_source").then((table) => { opened = true; return table; });
  const independent = await warehouse.open("independent_source");
  await independent.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(opened, false, "the same source waits through extraction, while another source can run");
  await first.close();
  const second = await waiting;
  assert.equal(opened, true, "closing the connection releases the source lock");
  await second.close();
});

test("Postgres exposes API progress and records together only after COMMIT", async (t) => {
  const server = serverConfig();
  if (typeof server === "string") return t.skip(server);
  let admin: Connection;
  try { admin = await connect({ ...server, database: "postgres" }); }
  catch (error) { if (process.env.CI) throw error; return t.skip(String(error)); }
  const database = `bj_test_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database "${database}"`);
  const cleanups: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of cleanups) await close(); await admin.query(`drop database "${database}" with (force)`); await admin.close(); });
  const config = { ...server, database };
  const observer = await connect(config);
  cleanups.push(() => observer.close());
  let pause = false;
  let signalReady!: () => void;
  let signalRelease!: () => void;
  const ready = new Promise<void>((resolve) => { signalReady = resolve; });
  const release = new Promise<void>((resolve) => { signalRelease = resolve; });
  cleanups.unshift(async () => signalRelease());
  const warehouse = postgresWarehouse({ schema: "raw", connect: async () => {
    const connection = await connect(config);
    return { ...connection, async query<R>(text: string, params?: unknown[]) {
      if (pause && text === "commit") { signalReady(); await release; }
      return connection.query<R>(text, params);
    } };
  } });
  const table = await warehouse.open("test_candles");
  table.trackInputs("atomic-run", (complete) => inputEvidence({ name: "test", table: "candles" }, {},
    { files: { "tokens.json": [{ sha256: "hash", bytes: 42 }] }, truncated: false }, complete));
  cleanups.push(() => table.close());
  pause = true;
  const loading = table.load({ records: [{ id: "1", callId: "window", data: { close: 12 } }], failed: [],
    checkpoints: [{ key: "history", value: { next: 20 } }] });
  await ready;
  assert.deepEqual((await observer.query("select * from raw.test_candles")).rows, []);
  assert.deepEqual((await observer.query("select * from raw._checkpoints")).rows, []);
  assert.deepEqual((await observer.query("select * from raw._ingestion_inputs")).rows, []);
  signalRelease();
  await loading;
  assert.equal((await observer.query("select * from raw.test_candles")).rows.length, 1);
  assert.equal((await observer.query("select * from raw._checkpoints")).rows.length, 1);
  assert.deepEqual((await observer.query("select run_id, source_table, evidence->>'complete' as complete from raw._ingestion_inputs")).rows,
    [{ run_id: "atomic-run", source_table: "test_candles", complete: "false" }]);
});

test("Postgres metadata permissions do not prevent a source from committing data", async (t) => {
  const server = serverConfig();
  if (typeof server === "string") return t.skip(server);
  let admin: Connection;
  try { admin = await connect({ ...server, database: "postgres" }); }
  catch (error) { if (process.env.CI) throw error; return t.skip(String(error)); }
  const id = randomBytes(6).toString("hex");
  const database = `bj_test_${id}`;
  const role = `bj_writer_${id}`;
  await admin.query(`create database "${database}"`);
  await admin.query(`create role "${role}"`);
  const connections: Connection[] = [];
  t.after(async () => {
    for (const connection of connections) await connection.close();
    await admin.query(`drop database "${database}" with (force)`);
    await admin.query(`drop role "${role}"`);
    await admin.close();
  });
  const config = { ...server, database };
  const owner = await connect(config);
  connections.push(owner);
  const setup = postgresWarehouse({ schema: "raw", connect: () => connect(config) });
  await (await setup.open("test_wallets")).close();
  await owner.query(`grant create on database "${database}" to "${role}"`);
  await owner.query(`grant usage, create on schema raw to "${role}"`);
  await owner.query(`grant all on all tables in schema raw to "${role}"`);
  // Existing warehouse setup creates the dead-letter paging index, requiring its table owner.
  await owner.query(`alter table raw._dead_letters owner to "${role}"`);
  await owner.query(`revoke insert, update on raw._ingestion_inputs from "${role}"`);
  const warehouse = postgresWarehouse({ schema: "raw", connect: async () => {
    const connection = await connect(config);
    connections.push(connection);
    await connection.query(`set role "${role}"`);
    return connection;
  } });
  const table = await warehouse.open("test_wallets");
  table.trackInputs("unprivileged-run", (complete) => inputEvidence({ name: "test", table: "wallets" }, {},
    { files: {}, truncated: false }, complete));
  await table.load({ records: [{ id: "one", callId: "one", data: {} }], failed: [], checkpoints: [{ key: "next", value: 2 }] });
  await table.finishInputs();
  assert.deepEqual((await owner.query("select id from raw.test_wallets")).rows, [{ id: "one" }]);
  assert.equal(await table.getCheckpoint("next"), 2);
  assert.deepEqual((await owner.query("select * from raw._ingestion_inputs")).rows, []);
});
