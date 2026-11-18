import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/clock.ts";
import { historyKey } from "#src/history.ts";
import { RETRY_WAITS_MS } from "#src/lighter/retry.ts";
import { lighterDaysEnv, loadDays, type DayCall } from "#src/lighter/s3.ts";
import { PREFIX, fakeBucket, parquetFile, type FakeBucket } from "#src/lighter/s3.fixture.ts";
import type { Batch, Checkpoint } from "#src/source.ts";

const DATASET = "trades";

/** A bucket of trade files for `dates`, each listed with the ETag `etag-<date>` and holding three rows, `n` 0 to 2. */
async function bucketOf(t: TestContext, dates: string[]): Promise<FakeBucket> {
  const files: Record<string, Buffer> = {};
  for (const date of dates) files[date] = await parquetFile(t, `select '${date}' as day, n from range(3) t(n)`);
  return fakeBucket(t, DATASET, files);
}

/** A clock at `iso` whose sleeps end at once. */
const clockAt = (iso: string): Clock => ({ now: () => Date.parse(iso), sleep: async () => {} });

const rowId = (row: Record<string, unknown>) => `${row.day}:${row.n}`;

type Saved = Record<string, unknown>;

async function run(
  bucket: FakeBucket,
  { start = "2026-11-14", end = "2026-11-16", retry = [], saved = {}, clock = clockAt("2026-11-17T08:00:00Z"), where, rowsPerChunk }: {
    start?: string;
    end?: string | null;
    retry?: DayCall[];
    saved?: Saved;
    clock?: Clock;
    where?: string;
    rowsPerChunk?: number;
  } = {},
): Promise<Batch<DayCall>[]> {
  const env = lighterDaysEnv.parse({ ...bucket.env, START_DATE: start, ...(end ? { END_DATE: end } : {}) });
  const context = { getCheckpoint: async (key: string) => saved[key] };
  const batches: Batch<DayCall>[] = [];
  for await (const batch of loadDays(env, retry, context, { dataset: DATASET, rowId, clock, where, rowsPerChunk })) batches.push(batch);
  return batches;
}

const KEY = (bucket: FakeBucket) => historyKey(["lighter", bucket.env.LIGHTER_S3_URL, PREFIX, DATASET]);
const checkpointOf = (batches: Batch<DayCall>[]): Checkpoint => batches.flatMap((b) => b.checkpoints ?? []).at(-1)!;
const asSaved = (checkpoint: Checkpoint): Saved => ({ [checkpoint.key]: checkpoint.value });
const etags = (...dates: string[]) => Object.fromEntries(dates.map((date) => [date, `etag-${date}`]));
const retriesOf = (batches: Batch<DayCall>[]) => batches.flatMap((b) => b.failed.map((f) => f.call));

/** Each batch in short: a chunk as `<call id> ×<records>`, a closing batch as `done <id>` or `failed <id>`. */
const outline = (batches: Batch<DayCall>[]) =>
  batches.map((b) =>
    b.failed.length
      ? `failed ${b.failed.map((f) => f.id).join()}`
      : b.succeededCallIds
        ? `done ${b.succeededCallIds.join()}`
        : `${b.records[0]?.callId} ×${b.records.length}`,
  );

test("loads each listed day once, and skips a day loaded with the same ETag", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"]);
  const first = await run(bucket);
  assert.deepEqual(bucket.downloads, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  assert.deepEqual(outline(first), [
    "trades:2026-11-14#0 ×3",
    "done trades:2026-11-14",
    "trades:2026-11-15#0 ×3",
    "done trades:2026-11-15",
    "trades:2026-11-16#0 ×3",
    "done trades:2026-11-16",
  ]);
  const checkpoint = checkpointOf(first);
  assert.equal(checkpoint.key, KEY(bucket));
  assert.deepEqual(checkpoint.value, { files: etags("2026-11-14", "2026-11-15", "2026-11-16") });

  bucket.downloads.length = 0;
  assert.deepEqual(await run(bucket, { saved: asSaved(checkpoint) }), []);
  assert.deepEqual(bucket.downloads, []);
});

test("a day whose ETag changed loads again", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-14", "2026-11-15"]);
  const first = await run(bucket, { end: "2026-11-15" });
  bucket.downloads.length = 0;
  bucket.etags.set("2026-11-15", "etag-new");
  const second = await run(bucket, { end: "2026-11-15", saved: asSaved(checkpointOf(first)) });
  assert.deepEqual(bucket.downloads, ["2026-11-15"]);
  assert.deepEqual(outline(second), ["trades:2026-11-15#0 ×3", "done trades:2026-11-15"]);
  assert.deepEqual(checkpointOf(second).value, { files: { "2026-11-14": "etag-2026-11-14", "2026-11-15": "etag-new" } });
});

test("a failed day waits as a dead letter, and the next day still loads", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  bucket.broken.add("2026-11-15");
  const batches = await run(bucket);
  assert.deepEqual(outline(batches), [
    "trades:2026-11-14#0 ×3",
    "done trades:2026-11-14",
    "failed trades:2026-11-15",
    "trades:2026-11-16#0 ×3",
    "done trades:2026-11-16",
  ]);
  const { failed, ...rest } = batches[2]!;
  assert.deepEqual(failed.map(({ id, call }) => ({ id, call })), [
    { id: "trades:2026-11-15", call: { date: "2026-11-15", etag: "etag-2026-11-15" } },
  ]);
  assert.match(failed[0]!.error, /date=2026-11-15\/trades\.parquet answered HTTP 500/);
  // The batch that holds the dead letter also records the day, so both commit together.
  assert.deepEqual(rest, {
    records: [],
    callsCompleted: 1,
    checkpoints: [{ key: KEY(bucket), value: { files: etags("2026-11-14", "2026-11-15") } }],
  });
});

test("a failed last day is recorded too, so only its retry reads it again", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  bucket.broken.add("2026-11-16");
  const first = await run(bucket);
  const saved = asSaved(checkpointOf(first));
  assert.deepEqual(saved[KEY(bucket)], { files: etags("2026-11-14", "2026-11-15", "2026-11-16") });

  bucket.broken.clear();
  bucket.downloads.length = 0;
  assert.deepEqual(await run(bucket, { saved }), []);
  assert.deepEqual(bucket.downloads, []);

  const second = await run(bucket, { saved, retry: retriesOf(first) });
  assert.deepEqual(bucket.downloads, ["2026-11-16"]);
  assert.deepEqual(outline(second), ["trades:2026-11-16#0 ×3", "done trades:2026-11-16"]);
});

test("a dead-lettered day that the manifest lists as loaded is read again on the next run", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  bucket.broken.add("2026-11-15");
  const first = await run(bucket);
  // The manifest lists 2026-11-15, so the next run finds nothing pending.
  const saved = asSaved(checkpointOf(first));
  assert.equal((saved[KEY(bucket)] as { files: Record<string, string> }).files["2026-11-15"], "etag-2026-11-15");

  bucket.broken.clear();
  bucket.downloads.length = 0;
  const second = await run(bucket, { saved, retry: retriesOf(first) });
  assert.deepEqual(bucket.downloads, ["2026-11-15"]);
  assert.equal(second.flatMap((b) => b.records).length, 3);
  assert.deepEqual(second.at(-1)!.succeededCallIds, ["trades:2026-11-15"]);
  // The retried day's checkpoint keeps the other days.
  assert.deepEqual(checkpointOf(second).value, { files: etags("2026-11-14", "2026-11-15", "2026-11-16") });
});

test("a retried call for a pending date is made once", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-14", "2026-11-15"]);
  const batches = await run(bucket, { end: "2026-11-15", retry: [{ date: "2026-11-15", etag: "old" }] });
  assert.deepEqual(bucket.downloads, ["2026-11-14", "2026-11-15"]);
  assert.equal(batches.flatMap((b) => b.records).length, 6);
});

test("a retried call whose file has gone fails again, naming the date", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-14", "2026-11-15"]);
  const first = await run(bucket, { end: "2026-11-15" });
  bucket.files.delete("2026-11-15");
  const retry: DayCall[] = [{ date: "2026-11-15", etag: "etag-2026-11-15" }];
  const second = await run(bucket, { end: "2026-11-15", saved: asSaved(checkpointOf(first)), retry });
  // No checkpoint: the manifest already holds the date.
  assert.deepEqual(second, [
    {
      records: [],
      failed: [{ id: "trades:2026-11-15", call: retry[0], error: "Lighter S3 has no trades file for 2026-11-15" }],
      callsCompleted: 1,
    },
  ]);
});

test("a run lists the bucket once, retries included", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-12", "2026-11-14", "2026-11-15", "2026-11-16"]);
  const saved = { [KEY(bucket)]: { files: etags("2026-11-14", "2026-11-15") } };
  // Retried dates: one before START_DATE, one with no file, one the manifest holds, and one pending anyway.
  const retry = ["2026-11-12", "2026-11-13", "2026-11-15", "2026-11-16"].map((date) => ({ date, etag: `etag-${date}` }));
  const batches = await run(bucket, { saved, retry });
  assert.equal(bucket.lists, 1);
  assert.deepEqual(bucket.downloads, ["2026-11-12", "2026-11-15", "2026-11-16"]);
  assert.deepEqual(batches.flatMap((b) => b.failed.map((f) => f.id)), ["trades:2026-11-13"]);
});

test("a retried date before START_DATE loads from the same listing", async (t) => {
  // 2026-11-12 lies between the retried date and START_DATE, and no call asks for it.
  const bucket = await bucketOf(t, ["2026-11-10", "2026-11-12", "2026-11-14", "2026-11-15"]);
  const batches = await run(bucket, { end: "2026-11-15", retry: [{ date: "2026-11-10", etag: "etag-2026-11-10" }] });
  assert.equal(bucket.lists, 1);
  assert.deepEqual(bucket.downloads, ["2026-11-10", "2026-11-14", "2026-11-15"]);
  assert.deepEqual(outline(batches).filter((line) => line.startsWith("done")), [
    "done trades:2026-11-10",
    "done trades:2026-11-14",
    "done trades:2026-11-15",
  ]);
  assert.deepEqual(checkpointOf(batches).value, { files: etags("2026-11-10", "2026-11-14", "2026-11-15") });
});

test("a failed listing fails the run", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-16"]);
  bucket.listReplies.push(...Array<{ status: number }>(RETRY_WAITS_MS.length + 1).fill({ status: 503 }));
  await assert.rejects(run(bucket, { retry: [{ date: "2026-11-15", etag: "etag-2026-11-15" }] }), /list of trades answered HTTP 503/);
  assert.deepEqual(bucket.downloads, []);
});

test("without END_DATE the run stops at yesterday in UTC", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  await run(bucket, { end: null, clock: clockAt("2026-11-16T05:00:00Z") });
  assert.deepEqual(bucket.downloads, ["2026-11-14", "2026-11-15"]);
});

test("START_DATE is required, and END_DATE may not precede it", () => {
  assert.throws(() => lighterDaysEnv.parse({}), /START_DATE/);
  assert.throws(
    () => lighterDaysEnv.parse({ START_DATE: "2026-11-14", END_DATE: "2026-11-13" }),
    /END_DATE may not come before START_DATE/,
  );
  assert.doesNotThrow(() => lighterDaysEnv.parse({ START_DATE: "2026-11-14", END_DATE: "2026-11-14" }));
  assert.doesNotThrow(() => lighterDaysEnv.parse({ START_DATE: "2026-11-14" }));
});

test("a day's chunks never clear its dead letter, and its closing batch does", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-16"]);
  const batches = await run(bucket, { start: "2026-11-16", rowsPerChunk: 2 });
  const record = (n: number, callId: string) => ({ id: `2026-11-16:${n}`, callId, data: { day: "2026-11-16", n: String(n) } });
  // A chunk's call id is no dead letter's, and 0 calls, so the run counts the day once.
  assert.deepEqual(batches, [
    { records: [record(0, "trades:2026-11-16#0"), record(1, "trades:2026-11-16#0")], failed: [], callsCompleted: 0 },
    { records: [record(2, "trades:2026-11-16#1")], failed: [], callsCompleted: 0 },
    {
      records: [],
      failed: [],
      succeededCallIds: ["trades:2026-11-16"],
      callsCompleted: 1,
      checkpoints: [{ key: KEY(bucket), value: { files: etags("2026-11-16") } }],
    },
  ]);
});

test("a day with no matching rows yields only its closing batch", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-16"]);
  const batches = await run(bucket, { start: "2026-11-16", where: "n < 0" });
  assert.deepEqual(batches, [
    {
      records: [],
      failed: [],
      succeededCallIds: ["trades:2026-11-16"],
      callsCompleted: 1,
      checkpoints: [{ key: KEY(bucket), value: { files: etags("2026-11-16") } }],
    },
  ]);
});

test("a saved manifest of the wrong shape counts as empty", async (t) => {
  const bucket = await bucketOf(t, ["2026-11-16"]);
  await run(bucket, { start: "2026-11-16", saved: { [KEY(bucket)]: "junk" } });
  assert.deepEqual(bucket.downloads, ["2026-11-16"]);
});
