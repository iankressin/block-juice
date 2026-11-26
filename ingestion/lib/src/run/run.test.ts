import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { Pushgateway, type Registry } from "@prometheus-io/client";
import { commonAbis, evmEventDecoder, evmPortalStream } from "@subsquid/pipes/evm";
import { PortalClient } from "@subsquid/pipes/portal-client";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import { erc20Abi } from "viem";
import * as z from "zod";
import { callBatches } from "#src/batches.ts";
import { runSource } from "#src/run/index.ts";
import { readJson } from "#src/json.ts";
import type { Batch, Source, StreamSource } from "#src/source.ts";
import { observeRequest, transportSnapshot } from "#src/transport-metrics.ts";
import { pgliteWarehouse } from "#src/warehouse/pglite.fixture.ts";

// loadEnv treats an empty value as unset, so the run pushes no metrics, even when the shell
// or a .env file sets PUSHGATEWAY_URL.
process.env.PUSHGATEWAY_URL = "";

type Wallet = { wallet: string };

const source = (
  extract: (retry: Wallet[]) => AsyncIterable<Batch<Wallet>>,
  env: z.ZodType = z.object({}),
): Source<unknown, Wallet> => ({
  name: "test",
  table: "wallets",
  env,
  call: z.object({ wallet: z.string() }),
  extract: (_env, retry) => extract(retry),
});

async function runLog(db: PGlite) {
  const { rows } = await db.query<Record<string, unknown>>(
    `select succeeded, records_written, failed_calls, retried_calls,
            dead_letters_pending, dead_letters_parked, error
     from ops.ingestion_runs order by started_at, finished_at`,
  );
  return rows;
}

test("a run retries the dead letters of earlier runs and records what it did", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  let retried: Wallet[] = [];

  await runSource(
    source(async function* () {
      yield { records: [{ id: "a", callId: "a", data: {} }], failed: [{ id: "c", call: { wallet: "c" }, error: "timeout" }] };
    }),
    warehouse,
  );
  await runSource(
    source(async function* (retry) {
      retried = retry;
      yield { records: retry.map((c) => ({ id: `2:${c.wallet}`, callId: c.wallet, data: {} })), failed: [] };
    }),
    warehouse,
  );

  assert.equal(process.exitCode, undefined, "both runs succeeded");
  assert.deepEqual(retried, [{ wallet: "c" }]);
  assert.deepEqual(await runLog(db), [
    { succeeded: true, records_written: 1, failed_calls: 1, retried_calls: 0, dead_letters_pending: 1, dead_letters_parked: 0, error: null },
    { succeeded: true, records_written: 1, failed_calls: 0, retried_calls: 1, dead_letters_pending: 0, dead_letters_parked: 0, error: null },
  ]);
});

test("a run that fails keeps the batches it loaded and records the error", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);

  await runSource(
    source(async function* () {
      yield { records: [{ id: "g", callId: "g", data: {} }], failed: [] };
      throw new Error("boom");
    }),
    warehouse,
  );

  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  assert.deepEqual((await db.query("select id from raw.test_wallets")).rows, [{ id: "g" }]);
  assert.deepEqual(await runLog(db), [
    { succeeded: false, records_written: 1, failed_calls: 0, retried_calls: 0, dead_letters_pending: null, dead_letters_parked: null, error: "boom" },
  ]);
});

test("an invalid environment fails the run, and the run log says why", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);

  await runSource(
    source(async function* () {}, z.object({ RUN_TEST_ENDPOINT: z.url() })),
    warehouse,
  );

  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  const [row] = await runLog(db);
  assert.equal(row?.succeeded, false);
  assert.match(String(row?.error), /Invalid environment[\s\S]*RUN_TEST_ENDPOINT/);
});

const SCOPE = "mexc-2026-11";

/** A stream source that reads each file in `reads` first, then pipes one block from a local Portal. */
function scopedStream(url: string, reads: string[]): StreamSource<unknown> {
  return {
    name: "test",
    table: "transfers",
    env: z.object({ START_BLOCK: z.number().default(1), PORTAL_URL: z.string().default(url) }),
    coverage: { filters: ["wallets"], unrestricted: ["wallets"] },
    stream: async () => {
      for (const path of reads) readJson(path);
      return evmPortalStream({
        id: "test",
        portal: new PortalClient({ url, finalized: true }),
        logger: "silent",
        outputs: evmEventDecoder({
          range: { from: 1, to: 1 },
          contracts: ["0x00000000000000000000000000000000000000aa"],
          events: { transfers: commonAbis.erc20.events.Transfer },
        }).pipe(({ transfers }) => transfers.map((t) => ({ id: String(t.block.number), callId: "1", data: {} }))),
      });
    },
  };
}

function useScope(t: TestContext, name: string) {
  process.env.SOURCE_SCOPE = name;
  t.after(() => { delete process.env.SOURCE_SCOPE; process.exitCode = undefined; });
}

async function oneBlockPortal(t: TestContext) {
  const transfer = encodeEvent({
    abi: erc20Abi, eventName: "Transfer", address: "0x00000000000000000000000000000000000000aa",
    args: { from: "0x00000000000000000000000000000000000000bb", to: "0x00000000000000000000000000000000000000bb", value: 1n },
  });
  const portal = await mockPortal({ blocks: [mockBlock({ number: 1, transactions: [{ logs: [transfer] }] })] });
  t.after(() => portal.close());
  return portal.url;
}

test("a scope run that read no scope file fails", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  useScope(t, SCOPE);
  const dir = mkdtempSync(join(tmpdir(), "scope-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A standing file, and a folder whose name only starts like the scope's, are not the scope's file.
  mkdirSync(join(dir, "scopes", `${SCOPE}-old`), { recursive: true });
  writeFileSync(join(dir, "addresses.json"), "{}");
  writeFileSync(join(dir, "scopes", `${SCOPE}-old`, "addresses.json"), "{}");
  await runSource(scopedStream(await oneBlockPortal(t), [
    join(dir, "addresses.json"), join(dir, "scopes", `${SCOPE}-old`, "addresses.json"),
  ]), warehouse);

  assert.equal(process.exitCode, 1);
  const [row] = await runLog(db);
  assert.equal(row?.succeeded, false);
  assert.match(String(row?.error), new RegExp(`SOURCE_SCOPE=${SCOPE} is set, but test\\.transfers read no file in scopes/${SCOPE}/`));
  assert.deepEqual((await db.query("select id from raw.test_transfers")).rows, []);
});

test("a scope run that read its scope's file loads", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  useScope(t, SCOPE);
  const dir = mkdtempSync(join(tmpdir(), "scope-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scopes", SCOPE), { recursive: true });
  const file = join(dir, "scopes", SCOPE, "addresses.json");
  writeFileSync(file, '{"wallets":["0x00000000000000000000000000000000000000bb"]}');
  await runSource(scopedStream(await oneBlockPortal(t), [file]), warehouse);

  assert.equal(process.exitCode, undefined);
  assert.deepEqual((await runLog(db)).map((row) => row.succeeded), [true]);
  assert.deepEqual((await db.query("select id from raw.test_transfers")).rows, [{ id: "1" }]);
});

test("legacy two-argument sources still receive every retry when the backlog exceeds one page", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const table = await warehouse.open("test_wallets");
  const calls = Array.from({ length: 1003 }, (_, i) => ({ wallet: String(i).padStart(5, "0") }));
  await table.load({ records: [], failed: calls.map((call) => ({ id: call.wallet, call, error: "old timeout" })) });
  await table.close();
  let seen: Wallet[] = [];
  await runSource(source(async function* (retry) {
    seen = retry;
    yield { records: [], failed: [], succeededCallIds: retry.map((call) => call.wallet) };
  }), warehouse);
  assert.deepEqual(seen, calls);
  const [run] = await runLog(db);
  assert.equal(run?.retried_calls, 1003);
  assert.equal(run?.dead_letters_pending, 0);
});

test("a waiting warehouse opener cannot publish current progress before owning the source", async (t) => {
  const { warehouse } = await pgliteWarehouse(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const open = warehouse.open;
  warehouse.open = async (name) => { await gate; return open(name); };
  const timer = t.mock.method(globalThis, "setInterval");
  const running = runSource(source(async function* () {
    assert.equal(timer.mock.callCount(), 1);
  }), warehouse);
  try {
    assert.equal(timer.mock.callCount(), 0);
  } finally {
    release();
    await running;
  }
});

test("the runner isolates transport counts between successive source runs", async (t) => {
  const { warehouse } = await pgliteWarehouse(t);
  for (let i = 0; i < 2; i++) {
    await runSource(source(async function* () {
      assert.equal(transportSnapshot().requestsStarted, 0);
      await observeRequest(async () => "reply");
      assert.equal(transportSnapshot().requestsCompleted, 1);
    }), warehouse);
  }
  assert.equal(transportSnapshot().requestsStarted, 0);
});

test("pending and final progress finish before the warehouse releases its source lock", async (t) => {
  const { warehouse } = await pgliteWarehouse(t);
  const deferred = () => {
    let resolve!: () => void;
    return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
  };
  const active = { started: deferred(), release: deferred() };
  const final = { started: deferred(), release: deferred() };
  let pushes = 0;
  let closed = false;
  let tick!: () => void;
  const originalInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
    tick = callback;
    return originalInterval(callback, ms);
  });
  const open = warehouse.open;
  warehouse.open = async (name) => {
    const table = await open(name);
    return { ...table, close: async () => { closed = true; await table.close(); } };
  };
  t.mock.method(Pushgateway.prototype, "pushAdd", async () => {
    const pending = [active, final][pushes++];
    if (pending) { pending.started.resolve(); await pending.release.promise; }
  });
  process.env.PUSHGATEWAY_URL = "http://metrics.invalid";
  t.after(() => { process.env.PUSHGATEWAY_URL = ""; });
  const running = runSource(source(async function* () { tick(); }), warehouse);
  try {
    await active.started.promise;
    assert.equal(closed, false);
    active.release.resolve();
    await final.started.promise;
    assert.equal(closed, false, "the next source owner must wait until final progress is sent");
    assert.equal(pushes, 2);
  } finally {
    active.release.resolve();
    final.release.resolve();
    await running;
  }
  assert.equal(closed, true);
  assert.equal(pushes, 3, "completed-run metrics are still published");
});

test("lazy call-source fingerprints follow exact runs, including empty success and partially committed failure", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const dir = mkdtempSync(join(tmpdir(), "run-inputs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "wallets.json");
  const initial = '["original-wallet"]';
  const changed = '["new-wallet"]';
  writeFileSync(path, initial);
  await runSource(source(async function* () {
    await Promise.resolve();
    readJson(path);
    writeFileSync(path, changed);
    // A source can finish successfully without yielding a batch.
  }), warehouse);
  await runSource(source(async function* () {
    await Promise.resolve();
    readJson(path);
    yield { records: [{ id: "one", callId: "one", data: {} }], failed: [] };
    throw new Error("interrupted extraction");
  }), warehouse);
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  const { rows } = await db.query<{
    succeeded: boolean; config_hash: string; evidence: { complete: boolean; files: Record<string, unknown> };
  }>(`select r.succeeded, i.config_hash, i.evidence
    from ops.ingestion_runs r join raw._ingestion_inputs i
      on i.run_id = r.run_id::text and i.source_table = r.source || '_' || r.table_name
    order by r.started_at`);
  assert.equal(rows.length, 2);
  for (const [index, text] of [initial, changed].entries()) {
    assert.equal(rows[index]?.succeeded, index === 0);
    assert.equal(rows[index]?.evidence.complete, index === 0);
    assert.deepEqual(rows[index]?.evidence.files[path], [{
      sha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text),
    }]);
  }
  assert.notEqual(rows[0]?.config_hash, rows[1]?.config_hash);
  assert.doesNotMatch(JSON.stringify(rows), /original-wallet|new-wallet/);
  assert.deepEqual((await db.query("select id from raw.test_wallets")).rows, [{ id: "one" }]);
});

test("fresh batches account for matching retries beyond the first page", async (t) => {
  const { db, warehouse } = await pgliteWarehouse(t);
  const calls = Array.from({ length: 600 }, (_, i) => ({ wallet: String(i).padStart(3, "0") }));
  const table = await warehouse.open("test_wallets");
  await table.load({ records: [], failed: calls.map((call) => ({
    id: call.wallet, call, error: "timeout",
  })) });
  await table.close();

  const paged: Source<unknown, Wallet> = {
    ...source(async function* () {}), retryMode: "paged",
    async *extract(_env, retry, context) {
      for await (const batch of callBatches(calls, retry, (call) => call.wallet, () => true, context)) {
        yield { records: [], failed: [], succeededCallIds: batch.map((call) => call.wallet) };
      }
    },
  };
  await runSource(paged, warehouse);
  const [report] = await runLog(db);
  assert.equal(report?.dead_letters_pending, 0);
  assert.equal(report?.retried_calls, calls.length);
});

test("the runner counts explicit terminal outcomes and infers outcomes for ordinary batches", async (t) => {
  const { warehouse } = await pgliteWarehouse(t);
  process.env.PUSHGATEWAY_URL = "http://metrics.invalid";
  t.after(() => { process.env.PUSHGATEWAY_URL = ""; });
  let completed: number | undefined;
  t.mock.method(Pushgateway.prototype, "pushAdd", async function (this: { registry: Registry }) {
    const metrics = await this.registry.getMetricsAsJSON();
    const gauge = metrics.find((metric) => metric.name === "ingestion_current_calls_completed");
    if (gauge) completed = gauge.values[0]!.value;
  });
  await runSource(source(async function* () {
    yield { records: [{ id: "one", callId: "walk#0", data: {} }], failed: [], callsCompleted: 0 };
    yield { records: [], failed: [], succeededCallIds: ["walk"], callsCompleted: 1 };
    yield { records: [{ id: "two", callId: "other", data: {} }], failed: [] };
  }), warehouse);
  assert.equal(completed, 2);
});
