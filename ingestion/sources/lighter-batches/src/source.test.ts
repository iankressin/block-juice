import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { historyKey, type Batch, type Clock, type ExtractionContext } from "@ingestion/lib";
import { batchesSource, type LighterBatchesEnv } from "#src/source.ts";

type Call = { kind: "batch"; batch_number: number };
type Reply = { status: number; body: unknown };

const MINUTE = 60_000;
const T0 = Date.parse("2026-11-16T00:00:00Z");
// The fake serves batches 120 to 200 and answers 404 below 120. Batch n starts at T0 + n minutes.
const FIRST = 120;
const HEAD = 200;
const FINAL = ["committed", "verified", "executed"];

// The Explorer writes 0 to 6 decimals on the seconds; the fake spreads them over the blocks.
const FRACTIONS = ["", ".5", ".25", ".125", ".0625", ".03125", ".015625"];
const seconds = (ms: number) => new Date(ms).toISOString().slice(0, 19);

/** Batch n as the Explorer sends it: 10 blocks from block 10n, one a second from T0 + n minutes. */
function batchReply(n: number, statuses: readonly string[] = FINAL): Record<string, unknown> {
  const start = T0 + n * MINUTE;
  return {
    batch_number: n,
    updated_at: `${seconds(start + 50_000)}.973588Z`,
    batch_details: statuses.length
      ? { commit_tx_hash: `0xc${n}`, verify_tx_hash: null, execute_tx_hash: statuses.includes("executed") ? `0xe${n}` : null }
      : null,
    blocks: Array.from({ length: 10 }, (_, i) => ({
      block_number: 10 * n + i,
      updated_at: `${seconds(start + i * 1000)}${FRACTIONS[(n + i) % FRACTIONS.length]}Z`,
      total_transactions: 500,
    })),
    status_changes: statuses.map((batch_status, i) => ({
      hash: `0x${n}${i}`,
      updated_at: `${seconds(start + (i + 1) * 20_000)}Z`,
      batch_status,
    })),
  };
}

/**
 * The Explorer's `/batches` and `/batches/{n}`. `statuses` sets a batch's status changes and can change
 * between runs; `reply` replaces the answer for a batch. `requests` gets each path asked for.
 */
async function fakeExplorer(
  t: TestContext,
  { statuses = {}, reply }: { statuses?: Record<number, readonly string[]>; reply?: (n: number) => Reply | undefined } = {},
) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://explorer").pathname;
    requests.push(path);
    let answer: Reply;
    if (path === "/api/batches") {
      // Ordered by updated_at, not by number, as the Explorer does: the head is not first.
      const recent = [HEAD - 1, HEAD, ...Array.from({ length: 18 }, (_, i) => HEAD - 2 - i)];
      answer = { status: 200, body: recent.map((n) => ({ batch_number: n, updated_at: seconds(T0 + n * MINUTE), batch_size: 10 })) };
    } else {
      const n = Number(path.split("/").at(-1));
      answer = reply?.(n)
        ?? (n < FIRST || n > HEAD
          ? { status: 404, body: { error: `batch=${n} not found with block=0` } }
          : { status: 200, body: batchReply(n, statuses[n]) });
    }
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A clock that a sleep moves forward at once. */
function fakeClock(): Clock {
  let now = T0 + 1000 * MINUTE;
  return { now: () => now, sleep: async (ms) => void (now += ms) };
}

const START = T0 + 150.5 * MINUTE;

const envAt = (url: string, start: number): LighterBatchesEnv => ({
  LIGHTER_EXPLORER_URL: url,
  LIGHTER_EXPLORER_WEIGHT_PER_MINUTE: 45,
  START_TIME: start,
});

/** One run. `saved` is the checkpoint the warehouse holds for the run's key. */
async function run(url: string, { start = START, saved, retry = [] }: { start?: number; saved?: unknown; retry?: Call[] } = {}) {
  const key = historyKey(["lighter", url, "batches", start]);
  const context: ExtractionContext<Call> = { getCheckpoint: async (k) => (k === key ? saved : undefined) };
  const batches: Batch<Call>[] = [];
  for await (const batch of batchesSource(fakeClock()).extract(envAt(url, start), retry, context)) batches.push(batch);
  return { batches, key, checkpoint: batches.at(-1)?.checkpoints };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const batchReads = (requests: string[]) => requests.filter((p) => p.startsWith("/api/batches/")).map((p) => Number(p.split("/").at(-1)));
const ids = (batches: Batch<Call>[]) => batches.flatMap((b) => b.records.map((r) => r.id));
const call = (batch_number: number): Call => ({ kind: "batch", batch_number });

test("starts at the batch holding START_TIME, found by bisection, counting a 404 as before", async (t) => {
  const { url, requests } = await fakeExplorer(t);

  const { batches, key, checkpoint } = await run(url, { start: START });

  assert.equal(requests[0], "/api/batches");
  const reads = batchReads(requests);
  const walk = range(150, HEAD);
  assert.deepEqual(reads.slice(-walk.length), walk);
  assert.ok(reads.length - walk.length <= 8, `${reads.length - walk.length} batch reads before the walk`);
  assert.deepEqual(ids(batches), walk.map((n) => `batch:${n}`));
  // Every 10 batches go out with a checkpoint.
  assert.deepEqual(batches.map((b) => b.records.length), [10, 10, 10, 10, 10, 1]);
  assert.deepEqual(checkpoint, [{ key, value: { origin: 150, next: HEAD + 1 } }]);
});

test("START_TIME before the first batch served starts at that batch", async (t) => {
  const { url } = await fakeExplorer(t);

  const { batches, key, checkpoint } = await run(url, { start: T0 });

  assert.deepEqual(ids(batches), range(FIRST, HEAD).map((n) => `batch:${n}`));
  assert.deepEqual(checkpoint, [{ key, value: { origin: FIRST, next: HEAD + 1 } }]);
});

test("a first block a fraction of a millisecond after START_TIME is after it", async (t) => {
  // Batch 152's first block is at 02:32:00.03125, a quarter of a millisecond after 02:32:00.031.
  const { url } = await fakeExplorer(t);

  const { key, checkpoint } = await run(url, { start: Date.parse("2026-11-16T02:32:00.031Z") });

  assert.deepEqual(checkpoint, [{ key, value: { origin: 151, next: HEAD + 1 } }]);
});

test("reads from the checkpoint to the head and keeps each reply as sent, keyed by batch number", async (t) => {
  const { url, requests } = await fakeExplorer(t);

  const { batches } = await run(url, { saved: { origin: 150, next: 198 } });

  assert.deepEqual(requests, ["/api/batches", "/api/batches/198", "/api/batches/199", "/api/batches/200"]);
  assert.deepEqual(
    batches.flatMap((b) => b.records),
    [198, 199, 200].map((n) => ({ id: `batch:${n}`, callId: `batch:${n}`, data: batchReply(n) })),
  );
  assert.deepEqual(batches.flatMap((b) => b.failed), []);
});

test("a batch not yet final is read again next run, and the checkpoint stops before it", async (t) => {
  const statuses: Record<number, readonly string[]> = {
    198: ["committed", "verified", "executed"],
    199: ["committed"],
    200: ["committed", "nothing_to_execute"],
  };
  const { url, requests } = await fakeExplorer(t, { statuses });

  const first = await run(url, { saved: { origin: 150, next: 198 } });
  assert.deepEqual(first.checkpoint, [{ key: first.key, value: { origin: 150, next: 199 } }]);

  statuses[199] = ["committed", "verified", "executed"];
  requests.length = 0;
  const second = await run(url, { saved: first.checkpoint![0]!.value });

  assert.deepEqual(batchReads(requests), [199, 200]);
  assert.deepEqual(second.batches.flatMap((b) => b.records).map((r) => r.data), [batchReply(199), batchReply(200, statuses[200])]);
  assert.deepEqual(second.checkpoint, [{ key: second.key, value: { origin: 150, next: 201 } }]);
});

test("a failed batch waits as a dead letter, and the batches after it still load", async (t) => {
  // 199 lies between origin and the head, so its 404 is a failure, not the edge of the history.
  const { url } = await fakeExplorer(t, {
    reply: (n) =>
      n === 198 ? { status: 400, body: { error: "boom" } }
      : n === 199 ? { status: 404, body: { error: "batch=199 not found with block=0" } }
      : undefined,
  });

  const { batches, key, checkpoint } = await run(url, { saved: { origin: 150, next: 198 } });

  assert.deepEqual(batches.flatMap((b) => b.failed), [
    { id: "batch:198", call: call(198), error: "Lighter's Explorer answered HTTP 400 for /api/batches/198: boom" },
    { id: "batch:199", call: call(199), error: "Lighter's Explorer holds no batch 199" },
  ]);
  assert.deepEqual(ids(batches), ["batch:200"]);
  assert.deepEqual(checkpoint, [{ key, value: { origin: 150, next: 201 } }]);
});

test("a retried batch is read once even when the walk also covers it", async (t) => {
  const { url, requests } = await fakeExplorer(t);

  const { batches, key, checkpoint } = await run(url, { saved: { origin: 150, next: 198 }, retry: [call(199), call(120)] });

  assert.deepEqual(batchReads(requests), [198, 199, 200, 120]);
  assert.deepEqual(ids(batches), ["batch:198", "batch:199", "batch:200", "batch:120"]);
  assert.deepEqual(checkpoint, [{ key, value: { origin: 150, next: 201 } }]);
});

test("a retried batch not yet final holds the checkpoint back to it", async (t) => {
  // 180 failed in an earlier run, which moved on past it. It now answers, committed but not final.
  const { url, requests } = await fakeExplorer(t, { statuses: { 180: ["committed"] } });

  const { key, checkpoint } = await run(url, { saved: { origin: 150, next: HEAD + 1 }, retry: [call(180)] });

  assert.deepEqual(batchReads(requests), [180]);
  assert.deepEqual(checkpoint, [{ key, value: { origin: 150, next: 180 } }]);
});

test("START_TIME before 2025-08-28 is refused: earlier batches carry no L1 status", () => {
  const env = batchesSource().env;

  const refused = env.safeParse({ START_TIME: "2025-08-27T23:59:59Z" });

  assert.equal(refused.success, false);
  assert.deepEqual(refused.error!.issues.map((issue) => issue.path), [["START_TIME"]]);
  assert.match(refused.error!.issues[0]!.message, /2025-08-28T00:00:00Z.*batches before 29654 carry no L1 status and never settle/);
  assert.equal(env.safeParse({ START_TIME: "2025-08-28T00:00:00Z" }).success, true);
});
