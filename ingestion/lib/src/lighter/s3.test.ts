import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { Batch } from "#src/source.ts";
import type { Clock } from "#src/clock.ts";
import { RETRY_WAITS_MS } from "#src/lighter/retry.ts";
import { dayBatches, dayManifest, listDays, readDay, type DayCall, type DayFile } from "#src/lighter/s3.ts";
import { PREFIX, fakeBucket, parquetFile } from "#src/lighter/s3.fixture.ts";

/** Every attempt a read makes before it gives up: the first, then one after each wait. */
const ATTEMPTS = RETRY_WAITS_MS.length + 1;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** A Parquet file of four trades like trade 40627877458; three involve account 313004. */
const tradesFile = (t: TestContext) =>
  parquetFile(
    t,
    `select * from (values
      (40627877458::bigint, 0, 757337::bigint, 313004::bigint, 3491::bigint, 181952::bigint, 635194432::bigint, TIMESTAMPTZ '2026-11-16 00:00:01+00'),
      (40627877459::bigint, 0, 757337::bigint, 313004::bigint, 10::bigint, 181953::bigint, 1819530::bigint, TIMESTAMPTZ '2026-11-16 00:00:02+00'),
      (40627877460::bigint, 1, 5::bigint, 313004::bigint, 1::bigint, 2::bigint, 2::bigint, TIMESTAMPTZ '2026-11-16 00:00:03+00'),
      (40627877461::bigint, 1, 5::bigint, 6::bigint, 1::bigint, 2::bigint, 2::bigint, TIMESTAMPTZ '2026-11-16 00:00:04+00')
    ) t(id, market_id, ask_account_id, bid_account_id, size, price, usdc_amount, created_at)`,
  );

/** A clock that a sleep moves forward at once. `sleeps` gets each wait. */
function fakeClock(): Clock & { sleeps: number[] } {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

/** The trade files of 2026-11-14 to 2026-11-16, ETags e14 to e16, listed over two pages. */
async function listing(t: TestContext) {
  const x = Buffer.from("x");
  const bucket = await fakeBucket(t, "trades", { "2026-11-14": x, "2026-11-15": x, "2026-11-16": x });
  bucket.etags.set("2026-11-14", "e14").set("2026-11-15", "e15").set("2026-11-16", "e16");
  bucket.pageSize = 2;
  return bucket;
}

/** A listing page that is truncated and names `token` as the next one, or no token when unset. */
const truncatedPage = (token?: string) => ({
  status: 200,
  body: `<ListBucketResult><IsTruncated>true</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ""}</ListBucketResult>`,
});

const dayOf = (file: Buffer, date = "2026-11-16"): DayFile => ({
  dataset: "trades",
  date,
  key: `${PREFIX}/trades/date=${date}/trades.parquet`,
  etag: "e16",
  size: file.length,
});

test("listDays follows continuation tokens and keeps the dates in range", async (t) => {
  const { env } = await listing(t);
  const days = await listDays(env, "trades", "2026-11-15", "2026-11-16");
  assert.deepEqual(days.map((d) => [d.date, d.etag]), [["2026-11-15", "e15"], ["2026-11-16", "e16"]]);
  assert.equal(days[0]!.key, `${PREFIX}/trades/date=2026-11-15/trades.parquet`);
});

test("a listing that answers 503 then 200 succeeds after the first wait", async (t) => {
  const { env, requests, listReplies } = await listing(t);
  listReplies.push({ status: 503 });
  const clock = fakeClock();
  const days = await listDays(env, "trades", "2026-11-15", "2026-11-16", clock);
  assert.equal(days.length, 2);
  assert.equal(requests.length, 3);
  assert.deepEqual(clock.sleeps, [RETRY_WAITS_MS[0]]);
});

test("a Retry-After on a retried listing replaces the wait", async (t) => {
  const { env, listReplies } = await listing(t);
  listReplies.push({ status: 429, headers: { "retry-after": "7" } });
  const clock = fakeClock();
  await listDays(env, "trades", "2026-11-15", "2026-11-16", clock);
  assert.deepEqual(clock.sleeps, [7000]);
});

test("a listing that keeps failing throws after every wait", async (t) => {
  const down = { status: 500 };
  const { env, requests, listReplies } = await listing(t);
  listReplies.push(...Array<typeof down>(ATTEMPTS).fill(down));
  const clock = fakeClock();
  await assert.rejects(listDays(env, "trades", "2026-11-15", "2026-11-16", clock), /HTTP 500/);
  assert.equal(requests.length, ATTEMPTS);
  assert.deepEqual(clock.sleeps, RETRY_WAITS_MS);
});

test("a listing that hands back a used continuation token throws, naming the dataset", async (t) => {
  const { env, listReplies } = await fakeBucket(t, "trades", {});
  listReplies.push(truncatedPage("same"), truncatedPage("same"));
  await assert.rejects(listDays(env, "trades", "2026-11-15", "2026-11-16", fakeClock()), /list of trades repeated a continuation token/);
});

test("a truncated page with no continuation token throws", async (t) => {
  const { env, listReplies } = await fakeBucket(t, "open_interest_hourly", {});
  listReplies.push(truncatedPage());
  await assert.rejects(listDays(env, "open_interest_hourly", "2026-11-15", "2026-11-16", fakeClock()), /open_interest_hourly is truncated/);
});

test("a download that answers 500 then 200 loads the whole file", async (t) => {
  const file = await tradesFile(t);
  const { env, requests, downloadReplies } = await fakeBucket(t, "trades", { "2026-11-16": file });
  downloadReplies.push({ status: 500 });
  const clock = fakeClock();
  const chunks = await collect(readDay(env, dayOf(file), { clock }));
  assert.equal(chunks.flat().length, 4);
  assert.equal(requests.length, 2);
  assert.deepEqual(clock.sleeps, [RETRY_WAITS_MS[0]]);
});

test("a body that stalls after its headers fails at the deadline", async (t) => {
  const stalled = await fakeBucket(t, "trades", { "2026-11-16": Buffer.alloc(4096) });
  stalled.downloadReplies.push(...Array<"stall">(ATTEMPTS).fill("stall"));
  const started = Date.now();
  await assert.rejects(
    collect(readDay(stalled.env, dayOf(Buffer.alloc(4096)), { clock: fakeClock(), downloadTimeoutMs: 150 })),
    (error: Error) => {
      // The error names the key and keeps the timeout as its cause.
      assert.match(error.message, /date=2026-11-16.*timeout/);
      assert.equal((error.cause as Error).name, "TimeoutError");
      return true;
    },
  );
  assert.equal(stalled.requests.length, ATTEMPTS);
  assert.ok(Date.now() - started < 10_000);
});

test("a 404 on a download fails without a retry", async (t) => {
  // The bucket holds no file for the day, so it answers 404.
  const { env, requests } = await fakeBucket(t, "trades", {});
  const clock = fakeClock();
  await assert.rejects(collect(readDay(env, dayOf(Buffer.alloc(4096)), { clock })), /HTTP 404/);
  assert.equal(requests.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test("yields a day in chunks of rowsPerChunk rows, ids as strings, times in UTC", async (t) => {
  const file = await tradesFile(t);
  const { env } = await fakeBucket(t, "trades", { "2026-11-16": file });
  const chunks = await collect(
    readDay(env, dayOf(file), { where: "ask_account_id in (313004) or bid_account_id in (313004)", rowsPerChunk: 2 }),
  );
  assert.deepEqual(chunks.map((c) => c.length), [2, 1]);
  assert.equal(chunks[0]![0]!.id, "40627877458");
  assert.match(String(chunks[0]![0]!.created_at), /\+00$/);
});

test("a failed or short download fails, naming the key, and leaves no temporary file", async (t) => {
  const tmpDir = await mkdtemp(join(tmpdir(), "lighter-tmp-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  const failing = await fakeBucket(t, "trades", {});
  failing.broken.add("2026-11-16");
  await assert.rejects(collect(readDay(failing.env, dayOf(Buffer.alloc(4096)), { tmpDir, clock: fakeClock() })), /date=2026-11-16.*HTTP 500/);
  const short = await fakeBucket(t, "trades", { "2026-11-16": Buffer.alloc(4096) });
  short.downloadReplies.push(...Array<"short">(ATTEMPTS).fill("short"));
  await assert.rejects(collect(readDay(short.env, dayOf(Buffer.alloc(4096)), { tmpDir, clock: fakeClock() })), /expected 4096 bytes/);
  assert.deepEqual(await readdir(tmpDir), []);
});

test("readDay removes its temporary folder after a successful read", async (t) => {
  const file = await tradesFile(t);
  const { env } = await fakeBucket(t, "trades", { "2026-11-16": file });
  const tmpDir = await mkdtemp(join(tmpdir(), "lighter-tmp-"));
  t.after(() => rm(tmpDir, { recursive: true, force: true }));
  await collect(readDay(env, dayOf(file), { tmpDir }));
  assert.deepEqual(await readdir(tmpDir), []);
});

const d = (date: string, etag: string): DayFile => ({ dataset: "trades", date, key: `k${date}`, etag, size: 1 });

test("dayManifest skips days loaded with the same ETag and reloads a changed one", () => {
  const m = dayManifest("k", { files: { "2026-11-15": "a" } }, [d("2026-11-15", "a"), d("2026-11-16", "b")]);
  assert.deepEqual(m.pending.map((x) => x.date), ["2026-11-16"]);
  assert.equal(dayManifest("k", { files: { "2026-11-15": "a" } }, [d("2026-11-15", "c")]).pending.length, 1);
  m.loaded(d("2026-11-16", "b"));
  assert.deepEqual(m.loaded(d("2026-11-15", "a")).value, { files: { "2026-11-15": "a", "2026-11-16": "b" } });
});

test("dayManifest treats a saved value of the wrong shape as empty", () => {
  assert.equal(dayManifest("k", "junk", [d("2026-11-15", "a")]).pending.length, 1);
  assert.equal(dayManifest("k", undefined, [d("2026-11-15", "a")]).pending.length, 1);
});

test("dayBatches clears the day's dead letter only with its last chunk", async (t) => {
  const file = await tradesFile(t);
  const { env } = await fakeBucket(t, "trades", { "2026-11-16": file });
  const checkpoint = { key: "k", value: { files: { "2026-11-16": "e16" } } };
  const batches = await collect(dayBatches(env, dayOf(file), { where: "id < 40627877461", rowId: (r) => String(r.id), checkpoint, rowsPerChunk: 2 }));
  assert.deepEqual(
    batches.map((b) => [b.records.map((r) => r.callId), b.succeededCallIds]),
    [[["trades:2026-11-16#0", "trades:2026-11-16#0"], undefined], [["trades:2026-11-16"], ["trades:2026-11-16"]]],
  );
  assert.deepEqual(batches.at(-1)!.checkpoints, [checkpoint]);
  assert.equal(batches.at(-1)!.callsCompleted, 1);
  assert.equal(batches[0]!.checkpoints, undefined);
  assert.equal(batches[0]!.callsCompleted, 0);
  assert.deepEqual(batches[0]!.records.map((r) => r.id), ["40627877458", "40627877459"]);
  assert.equal(batches[0]!.records[0]!.data.id, "40627877458");
});

test("dayBatches yields one empty last batch for a day with no matching rows", async (t) => {
  const file = await tradesFile(t);
  const { env } = await fakeBucket(t, "trades", { "2026-11-16": file });
  const checkpoint = { key: "k", value: 1 };
  const batches = await collect(dayBatches(env, dayOf(file), { where: "id = 0", rowId: (r) => String(r.id), checkpoint }));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.records, []);
  assert.deepEqual(batches[0]!.succeededCallIds, ["trades:2026-11-16"]);
  assert.equal(batches[0]!.callsCompleted, 1);
  assert.deepEqual(batches[0]!.checkpoints, [checkpoint]);
});

test("dayBatches turns a failed day into a dead letter with no checkpoint", async (t) => {
  const { env, broken } = await fakeBucket(t, "trades", {});
  broken.add("2026-11-16");
  const day = dayOf(Buffer.alloc(4096));
  const batches: Batch<DayCall>[] = await collect(
    dayBatches(env, day, { rowId: (r) => String(r.id), checkpoint: { key: "k", value: 1 }, clock: fakeClock() }),
  );
  assert.equal(batches.length, 1);
  const b = batches[0]!;
  assert.deepEqual(b.records, []);
  assert.equal(b.failed[0]!.id, "trades:2026-11-16");
  assert.deepEqual(b.failed[0]!.call, { date: "2026-11-16", etag: "e16" });
  assert.match(b.failed[0]!.error, /HTTP 500/);
  assert.equal(b.callsCompleted, 1);
  assert.equal(b.checkpoints, undefined);
});
