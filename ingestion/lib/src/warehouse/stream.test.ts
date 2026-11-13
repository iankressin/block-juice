import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { commonAbis, evmEventDecoder, evmPortalStream } from "@subsquid/pipes/evm";
import { PortalClient } from "@subsquid/pipes/portal-client";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import { erc20Abi } from "viem";
import * as z from "zod";
import { runSource } from "#src/run/index.ts";
import type { StreamSource } from "#src/source.ts";
import { pgliteWarehouse } from "#src/warehouse/pglite.fixture.ts";

process.env.PUSHGATEWAY_URL = "";

/** Sets MAX_BLOCKS_PER_RUN for one test. Undefined deletes it, which is no cap. Restored afterwards. */
function useBlockCap(t: TestContext, value: string | undefined) {
  const saved = process.env.MAX_BLOCKS_PER_RUN;
  t.after(() => {
    if (saved === undefined) delete process.env.MAX_BLOCKS_PER_RUN;
    else process.env.MAX_BLOCKS_PER_RUN = saved;
  });
  if (value === undefined) delete process.env.MAX_BLOCKS_PER_RUN;
  else process.env.MAX_BLOCKS_PER_RUN = value;
}

const token = "0x00000000000000000000000000000000000000aa";
const wallet = "0x00000000000000000000000000000000000000bb";

/** A local Portal with one Transfer in each of blocks 1 to `last`, two blocks a response. */
async function chain(t: TestContext, last: number) {
  const transfer = encodeEvent({
    abi: erc20Abi,
    eventName: "Transfer",
    address: token,
    args: { from: wallet, to: wallet, value: 1n },
  });
  const blocks = Array.from({ length: last }, (_, i) =>
    mockBlock({ number: i + 1, transactions: [{ logs: [transfer] }] }),
  );
  const portal = await mockPortal({ blocks, blocksPerResponse: 2 });
  t.after(() => portal.close());
  return portal.url;
}

/** Transfers from block 1 to `to`. `broken` gives the record of that block an id Postgres rejects. */
function transfers(url: string, to: number, maxBlocksPerRun?: number, broken = () => 0): StreamSource<unknown> {
  return {
    name: "test",
    table: "transfers",
    env: z.object({ START_BLOCK: z.number().default(1), PORTAL_URL: z.string().default(url) }),
    coverage: { unrestricted: [] },
    maxBlocksPerRun,
    stream: async () =>
      evmPortalStream({
        id: "test",
        // The mock answers at once, so Pipes would merge every response into one batch. A tiny
        // maxBytes cuts a batch after each response, two blocks, like a slower real Portal.
        portal: new PortalClient({ url, finalized: true, maxBytes: 1 }),
        logger: "silent",
        outputs: evmEventDecoder({
          range: { from: 1, to },
          contracts: [token],
          events: { transfers: commonAbis.erc20.events.Transfer },
        }).pipe(({ transfers }) =>
          transfers.map((t) => {
            // Postgres text cannot hold a NUL byte, so this record fails its whole batch.
            const id = t.block.number === broken() ? "bad\u0000" : String(t.block.number);
            return { id, callId: id, data: { block: t.block.number } };
          }),
        ),
      }),
  };
}

const loaded = async (db: PGlite) =>
  (await db.query<{ id: string }>("select id from raw.test_transfers order by id::int")).rows.map((r) => r.id);
const cursor = async (db: PGlite) =>
  (await db.query<{ n: string }>("select max(current_number) as n from raw._sync where id = 'test_transfers'")).rows[0]?.n;

test("each run resumes after the last block the one before loaded, and stops after maxBlocksPerRun", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);
  const source = transfers(await chain(t, 6), 6, 3);

  await runSource(source, warehouse);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"], "the run stopped on the batch that passed 3 blocks");
  await runSource(source, warehouse);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4", "5", "6"]);
  await runSource(source, warehouse);

  assert.equal(process.exitCode, undefined, "every run succeeded");
  assert.equal(await cursor(db), "6");
  const { rows } = await db.query<{ records_written: number }>(
    "select records_written from ops.ingestion_runs order by started_at",
  );
  assert.deepEqual(rows.map((r) => r.records_written), [4, 2, 0], "the last run found nothing new");
});

test("a batch that fails to load commits neither its rows nor its block, so the next run reads it again", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);
  const url = await chain(t, 4);
  let broken = 3;

  await runSource(transfers(url, 4, 100, () => broken), warehouse);
  assert.equal(process.exitCode, 1, "the run failed");
  process.exitCode = undefined;
  assert.deepEqual(await loaded(db), ["1", "2"]);
  assert.equal(await cursor(db), "2");
  assert.deepEqual((await db.query("select from_block, to_block, verified from raw._coverage")).rows,
    [{ from_block: 1, to_block: 2, verified: true }], "failed batches commit neither data nor provenance");

  broken = 0;
  await runSource(transfers(url, 4, 100, () => broken), warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"]);
});

test("with MAX_BLOCKS_PER_RUN unset, a run has no cap and reads to the end block", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);
  const source = transfers(await chain(t, 6), 6);

  await runSource(source, warehouse);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4", "5", "6"]);
  await runSource(source, warehouse);

  assert.equal(process.exitCode, undefined, "both runs succeeded");
  assert.equal(await cursor(db), "6");
  const { rows } = await db.query<{ records_written: number }>(
    "select records_written from ops.ingestion_runs order by started_at",
  );
  assert.deepEqual(
    rows.map((r) => r.records_written),
    [6, 0],
    "every batch was reported, then the next run found nothing new",
  );
});

test("an empty MAX_BLOCKS_PER_RUN counts as unset, so the run reads to the end block", async (t) => {
  useBlockCap(t, "");
  const { db, warehouse } = await pgliteWarehouse(t);
  const source = transfers(await chain(t, 6), 6);

  await runSource(source, warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(await cursor(db), "6");
});

test("MAX_BLOCKS_PER_RUN caps the run when the source sets no maxBlocksPerRun", async (t) => {
  useBlockCap(t, "3");
  const { db, warehouse } = await pgliteWarehouse(t);

  await runSource(transfers(await chain(t, 6), 6), warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"], "the run stopped on the batch that passed 3 blocks");
  assert.equal(await cursor(db), "4");
});

test("MAX_BLOCKS_PER_RUN wins over the source's maxBlocksPerRun", async (t) => {
  useBlockCap(t, "3");
  const { db, warehouse } = await pgliteWarehouse(t);

  // The source would stop after 2 blocks. The env cap of 3 is what this run uses.
  await runSource(transfers(await chain(t, 6), 6, 2), warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"]);
});

test("the source's maxBlocksPerRun applies when MAX_BLOCKS_PER_RUN is unset", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);

  await runSource(transfers(await chain(t, 6), 6, 2), warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2"]);
  assert.equal(await cursor(db), "2");
});

test("MAX_BLOCKS_PER_RUN rejects 0, a negative, a decimal and text", async (t) => {
  const saved = process.env.MAX_BLOCKS_PER_RUN;
  t.after(() => {
    if (saved === undefined) delete process.env.MAX_BLOCKS_PER_RUN;
    else process.env.MAX_BLOCKS_PER_RUN = saved;
    process.exitCode = undefined;
  });
  const url = await chain(t, 4);
  for (const value of ["0", "-1", "1.5", "many"]) {
    process.env.MAX_BLOCKS_PER_RUN = value;
    process.exitCode = undefined;
    const { db, warehouse } = await pgliteWarehouse(t);
    await runSource(transfers(url, 4), warehouse);
    assert.equal(process.exitCode, 1, `${value} fails the run`);
    // The run fails before it opens the raw table, so the only record of it is the run log.
    const { rows } = await db.query<{ error: string | null; records_written: number }>(
      "select error, records_written from ops.ingestion_runs",
    );
    assert.equal(rows[0]?.records_written, 0, `${value} writes no records`);
    const error = rows[0]?.error ?? "";
    assert.match(error, /Invalid environment/, value);
    assert.match(error, /MAX_BLOCKS_PER_RUN/, value);
    assert.match(error, /positive whole number/, value);
    assert.match(error, /unset for no cap/, value);
  }
});

test("an uncapped run commits its cursor after each batch, so a failure resumes from the last one", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);
  const url = await chain(t, 6);
  let broken = 5;

  await runSource(transfers(url, 6, undefined, () => broken), warehouse);
  assert.equal(process.exitCode, 1, "the run failed");
  process.exitCode = undefined;
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"], "the two batches before the failure committed");
  assert.equal(await cursor(db), "4");
  const { rows } = await db.query<{ records_written: number }>(
    "select records_written from ops.ingestion_runs order by started_at",
  );
  assert.deepEqual(rows.map((r) => r.records_written), [4], "progress counts only the batches that committed");

  broken = 0;
  await runSource(transfers(url, 6, undefined, () => broken), warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(await cursor(db), "6");
});

test("a failure after data handling but before commit reports no durable rows or progress", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);
  const original = db.exec.bind(db);
  Object.defineProperty(db, "exec", { configurable: true, value: async (sql: string, ...args: unknown[]) => {
    if (/^commit\b/i.test(sql.trim())) throw new Error("simulated commit failure");
    return original(sql, ...args as []);
  } });
  await runSource(transfers(await chain(t, 2), 2), warehouse);
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  Object.defineProperty(db, "exec", { configurable: true, value: original });
  assert.deepEqual(await loaded(db), []);
  assert.deepEqual((await db.query("select * from raw._coverage")).rows, [], "coverage rolled back with the rows");
  assert.equal(await cursor(db), null, "the failed transaction did not advance its cursor");
  const { rows } = await db.query<{ records_written: number; load_seconds: number }>(
    "select records_written, load_seconds from ops.ingestion_runs");
  assert.equal(rows[0]!.records_written, 0, "a successful onData is not a committed batch");
  assert.equal(rows[0]!.load_seconds, 0);
});

test("a changed contract backfills into existing rows under a new cursor and resumes that generation", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);
  const source = transfers(await chain(t, 4), 4);
  await runSource(source, warehouse);
  source.coverage = { unrestricted: ["wallets"] };
  await runSource(source, warehouse);
  await runSource(source, warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"]);
  const runs = await db.query<{ records_written: number }>("select records_written from ops.ingestion_runs order by started_at");
  assert.deepEqual(runs.rows.map((row) => row.records_written), [4, 4, 0]);
  const configs = await db.query("select cursor_id from raw._source_configurations");
  assert.equal(configs.rows.length, 2, "both generation cursors remain available");
  assert.equal((await db.query("select distinct fingerprint from raw._coverage")).rows.length, 2);
});

test("adopting a legacy cursor verifies only subsequent blocks and never replays existing data", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);
  const url = await chain(t, 4);
  const legacy = transfers(url, 2);
  delete legacy.coverage;
  await runSource(legacy, warehouse);
  await runSource(transfers(url, 4), warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual((await db.query("select from_block, to_block from raw._coverage")).rows,
    [{ from_block: 3, to_block: 4 }]);
  const runs = await db.query<{ records_written: number }>("select records_written from ops.ingestion_runs order by started_at");
  assert.deepEqual(runs.rows.map((row) => row.records_written), [2, 2]);
});

test("an explicit backfill proves legacy history without deleting rows or the original cursor", async (t) => {
  useBlockCap(t, undefined);
  const saved = process.env.SOURCE_BACKFILL_ID;
  t.after(() => { if (saved === undefined) delete process.env.SOURCE_BACKFILL_ID; else process.env.SOURCE_BACKFILL_ID = saved; });
  const { db, warehouse } = await pgliteWarehouse(t);
  const source = transfers(await chain(t, 4), 4);
  delete source.coverage;
  await runSource(source, warehouse);
  source.coverage = { unrestricted: [] };
  process.env.SOURCE_BACKFILL_ID = "rebuild-history";
  await runSource(source, warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), ["1", "2", "3", "4"]);
  assert.equal(await cursor(db), "4");
  assert.deepEqual((await db.query("select from_block, to_block from raw._coverage")).rows,
    [{ from_block: 1, to_block: 4 }]);
});

test("empty event batches still commit their verified block interval", async (t) => {
  useBlockCap(t, undefined);
  const { db, warehouse } = await pgliteWarehouse(t);
  const source = transfers(await chain(t, 4), 4);
  const stream = source.stream.bind(source);
  source.stream = async (env) => (await stream(env)).pipe(() => []);
  await runSource(source, warehouse);
  assert.equal(process.exitCode, undefined);
  assert.deepEqual(await loaded(db), []);
  assert.equal(await cursor(db), "4");
  assert.deepEqual((await db.query("select from_block, to_block from raw._coverage")).rows,
    [{ from_block: 1, to_block: 4 }]);
});
