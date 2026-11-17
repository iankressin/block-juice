import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { historyKey, type Batch, type Checkpoint } from "@ingestion/lib";
import type { Clock } from "@ingestion/lib/lighter";
import { openInterestEnv, openInterestSource } from "#src/source.ts";

type Source = ReturnType<typeof openInterestSource>;
type Call = Parameters<Source["extract"]>[1][number];

const PREFIX = "v1.1/lighter/core/mainnet";

// The source package does not depend on DuckDB: take it from the lib, which does.
type Duck = { run(sql: string): Promise<unknown>; closeSync(): void };
const { DuckDBInstance } = createRequire(import.meta.resolve("@ingestion/lib"))("@duckdb/node-api") as {
  DuckDBInstance: { create(path: string): Promise<{ connect(): Promise<Duck>; closeSync(): void }> };
};

/** A Parquet file of one day's open interest: ETH and BTC at hours 22 and 23. */
async function dayFile(t: TestContext, date: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "lighter-oi-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "oi.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run(`COPY (
      select * from (values
        (TIMESTAMPTZ '${date} 22:00:00+00', 'ETH', 100.5, 3000.25, 301525.125),
        (TIMESTAMPTZ '${date} 22:00:00+00', 'BTC', 10.0, 90000.0, 900000.0),
        (TIMESTAMPTZ '${date} 23:00:00+00', 'ETH', 101.5, 3001.0, 304601.5),
        (TIMESTAMPTZ '${date} 23:00:00+00', 'BTC', 11.0, 90100.0, 991100.0)
      ) t(hour, symbol, open_interest, mark_price, open_interest_usd)
    ) TO '${path}' (FORMAT parquet, COMPRESSION zstd)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return readFile(path);
}

type Fake = {
  url: string;
  /** The dates whose file the fake served, one entry for each download. */
  downloads: string[];
  /** The dates whose download answers HTTP 500. */
  broken: Set<string>;
  /** The ETag the fake lists for a date. Change it to publish a new version of the file. */
  etags: Map<string, string>;
  /** Drop a date from the list. */
  remove(date: string): void;
};

/** Fake S3: a list of the day files, and the files. */
async function fakeS3(t: TestContext, dates: string[]): Promise<Fake> {
  const files = new Map<string, Buffer>();
  for (const date of dates) files.set(date, await dayFile(t, date));
  const etags = new Map(dates.map((date) => [date, `etag-${date}`]));
  const downloads: string[] = [];
  const broken = new Set<string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://s3");
    if (url.searchParams.get("list-type") === "2") {
      const contents = [...files]
        .map(
          ([date, body]) =>
            `<Contents><Key>${PREFIX}/open_interest_hourly/date=${date}/oi.parquet</Key><ETag>&quot;${etags.get(date)}&quot;</ETag><Size>${body.length}</Size></Contents>`,
        )
        .join("");
      res.setHeader("content-type", "application/xml");
      res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`);
      return;
    }
    const date = url.pathname.match(/date=(\d{4}-\d{2}-\d{2})\//)?.[1] ?? "";
    downloads.push(date);
    if (broken.has(date)) {
      res.statusCode = 500;
      res.end("boom");
      return;
    }
    res.end(files.get(date));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, downloads, broken, etags, remove: (date) => void files.delete(date) };
}

const fakeClock = (iso: string): Clock => ({ now: () => Date.parse(iso), sleep: async () => {} });

const KEY = (url: string) => historyKey(["lighter", url, PREFIX, "open_interest_hourly"]);

type Saved = Record<string, unknown>;

async function run(
  fake: Fake,
  { start = "2026-11-14", end = "2026-11-16", retry = [], saved = {}, clock = fakeClock("2026-11-17T08:00:00Z") }: {
    start?: string;
    end?: string | null;
    retry?: Call[];
    saved?: Saved;
    clock?: Clock;
  } = {},
) {
  const source = openInterestSource(clock);
  const env = openInterestEnv.parse({
    LIGHTER_S3_URL: fake.url,
    LIGHTER_S3_PREFIX: PREFIX,
    START_DATE: start,
    ...(end ? { END_DATE: end } : {}),
  });
  const batches: Batch<Call>[] = [];
  for await (const batch of source.extract(env, retry, { getCheckpoint: async (key) => saved[key] })) batches.push(batch);
  return batches;
}

const datesOf = (batches: Batch<Call>[]) => [...new Set(batches.flatMap((b) => b.records.map((r) => r.callId.split(":")[1]!.split("#")[0]!)))];
const checkpointOf = (batches: Batch<Call>[]): Checkpoint => batches.flatMap((b) => b.checkpoints ?? []).at(-1)!;
const asSaved = (checkpoint: Checkpoint): Saved => ({ [checkpoint.key]: checkpoint.value });

test("loads each listed day once, and skips a day loaded with the same ETag", async (t) => {
  const fake = await fakeS3(t, ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"]);
  const first = await run(fake);
  assert.deepEqual(datesOf(first), ["2026-11-14", "2026-11-15", "2026-11-16"]);
  assert.deepEqual(fake.downloads, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  assert.equal(first.flatMap((b) => b.records).length, 12);
  const row = first.flatMap((b) => b.records).find((r) => r.id === "ETH:2026-11-14 23:00:00+00")!;
  assert.equal(row.callId, "open_interest_hourly:2026-11-14");
  assert.deepEqual(row.data, {
    hour: "2026-11-14 23:00:00+00",
    symbol: "ETH",
    open_interest: "101.5",
    mark_price: "3001.00",
    open_interest_usd: "304601.500",
  });
  const checkpoint = checkpointOf(first);
  assert.equal(checkpoint.key, KEY(fake.url));
  assert.deepEqual(checkpoint.value, {
    files: { "2026-11-14": "etag-2026-11-14", "2026-11-15": "etag-2026-11-15", "2026-11-16": "etag-2026-11-16" },
  });

  fake.downloads.length = 0;
  const second = await run(fake, { saved: asSaved(checkpoint) });
  assert.deepEqual(second, []);
  assert.deepEqual(fake.downloads, []);
});

test("a day whose ETag changed loads again", async (t) => {
  const fake = await fakeS3(t, ["2026-11-14", "2026-11-15"]);
  const first = await run(fake, { end: "2026-11-15" });
  fake.downloads.length = 0;
  fake.etags.set("2026-11-15", "etag-new");
  const second = await run(fake, { end: "2026-11-15", saved: asSaved(checkpointOf(first)) });
  assert.deepEqual(fake.downloads, ["2026-11-15"]);
  assert.deepEqual(datesOf(second), ["2026-11-15"]);
  assert.deepEqual(checkpointOf(second).value, { files: { "2026-11-14": "etag-2026-11-14", "2026-11-15": "etag-new" } });
});

test("a failed day waits as a dead letter, and the next day still loads", async (t) => {
  const fake = await fakeS3(t, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  fake.broken.add("2026-11-15");
  const batches = await run(fake);
  assert.deepEqual(datesOf(batches), ["2026-11-14", "2026-11-16"]);
  const failed = batches.flatMap((b) => b.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.id, "open_interest_hourly:2026-11-15");
  assert.deepEqual(failed[0]!.call, { date: "2026-11-15", etag: "etag-2026-11-15" });
  assert.match(failed[0]!.error, /HTTP 500/);
  assert.equal(batches.filter((b) => b.failed.length).every((b) => !b.checkpoints), true);
});

test("a dead-lettered day that the manifest lists as loaded is read again on the next run", async (t) => {
  const fake = await fakeS3(t, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  fake.broken.add("2026-11-15");
  const first = await run(fake);
  // The later day's checkpoint lists 2026-11-15, so the next run finds nothing pending.
  const saved = asSaved(checkpointOf(first));
  assert.equal((saved[KEY(fake.url)] as { files: Record<string, string> }).files["2026-11-15"], "etag-2026-11-15");

  fake.broken.clear();
  fake.downloads.length = 0;
  const retry: Call[] = first.flatMap((b) => b.failed.map((f) => f.call));
  const second = await run(fake, { saved, retry });
  assert.deepEqual(fake.downloads, ["2026-11-15"]);
  assert.deepEqual(datesOf(second), ["2026-11-15"]);
  assert.equal(second.flatMap((b) => b.records).length, 4);
  assert.deepEqual(second.at(-1)!.succeededCallIds, ["open_interest_hourly:2026-11-15"]);
  // The retried day's checkpoint keeps the other days.
  assert.deepEqual(Object.keys((checkpointOf(second).value as { files: Record<string, string> }).files), [
    "2026-11-14",
    "2026-11-15",
    "2026-11-16",
  ]);
});

test("a retried call for a pending date is made once", async (t) => {
  const fake = await fakeS3(t, ["2026-11-14", "2026-11-15"]);
  const retry: Call[] = [{ date: "2026-11-15", etag: "old" }];
  const batches = await run(fake, { end: "2026-11-15", retry });
  assert.deepEqual(fake.downloads, ["2026-11-14", "2026-11-15"]);
  assert.equal(batches.flatMap((b) => b.records).length, 8);
});

test("a retried call whose file has gone fails again, naming the date", async (t) => {
  const fake = await fakeS3(t, ["2026-11-14", "2026-11-15"]);
  const first = await run(fake, { end: "2026-11-15" });
  fake.remove("2026-11-15");
  const retry: Call[] = [{ date: "2026-11-15", etag: "etag-2026-11-15" }];
  const second = await run(fake, { end: "2026-11-15", saved: asSaved(checkpointOf(first)), retry });
  assert.equal(second.flatMap((b) => b.records).length, 0);
  const failed = second.flatMap((b) => b.failed);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.id, "open_interest_hourly:2026-11-15");
  assert.deepEqual(failed[0]!.call, retry[0]);
  assert.match(failed[0]!.error, /2026-11-15/);
});

test("without END_DATE the run stops at yesterday in UTC", async (t) => {
  const fake = await fakeS3(t, ["2026-11-14", "2026-11-15", "2026-11-16"]);
  const batches = await run(fake, { end: null, clock: fakeClock("2026-11-16T05:00:00Z") });
  assert.deepEqual(datesOf(batches), ["2026-11-14", "2026-11-15"]);
});

test("START_DATE is required, and END_DATE may not precede it", () => {
  assert.throws(() => openInterestEnv.parse({}), /START_DATE/);
  assert.throws(() => openInterestEnv.parse({ START_DATE: "2026-11-14", END_DATE: "2026-11-13" }), /END_DATE/);
  assert.doesNotThrow(() => openInterestEnv.parse({ START_DATE: "2026-11-14", END_DATE: "2026-11-14" }));
  assert.doesNotThrow(() => openInterestEnv.parse({ START_DATE: "2026-11-14" }));
});
