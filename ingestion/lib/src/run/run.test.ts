import assert from "node:assert/strict";
import { test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { Pushgateway } from "@prometheus-io/client";
import * as z from "zod";
import { runSource } from "#src/run/index.ts";
import type { Batch, Source } from "#src/source.ts";
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
