import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { Batch } from "#src/source.ts";
import { dayBatches, dayManifest, listDays, readDay, type DayCall, type DayFile, type LighterS3Env } from "#src/lighter/s3.ts";

const PREFIX = "v1.1/lighter/core/mainnet";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** A Parquet file of four trades like trade 40627877458; three involve account 313004. */
async function writeTrades(path: string) {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run(`COPY (
      select * from (values
        (40627877458::bigint, 0, 757337::bigint, 313004::bigint, 3491::bigint, 181952::bigint, 635194432::bigint, TIMESTAMPTZ '2026-11-16 00:00:01+00'),
        (40627877459::bigint, 0, 757337::bigint, 313004::bigint, 10::bigint, 181953::bigint, 1819530::bigint, TIMESTAMPTZ '2026-11-16 00:00:02+00'),
        (40627877460::bigint, 1, 5::bigint, 313004::bigint, 1::bigint, 2::bigint, 2::bigint, TIMESTAMPTZ '2026-11-16 00:00:03+00'),
        (40627877461::bigint, 1, 5::bigint, 6::bigint, 1::bigint, 2::bigint, 2::bigint, TIMESTAMPTZ '2026-11-16 00:00:04+00')
      ) t(id, market_id, ask_account_id, bid_account_id, size, price, usdc_amount, created_at)
    ) TO '${path}' (FORMAT parquet, COMPRESSION zstd)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

type Fake = { env: LighterS3Env; file: Buffer };

/**
 * Fake S3. The list answers two pages. The file route serves `file`, or `fileStatus` when set;
 * `truncate` cuts the body short.
 */
async function fakeS3(t: TestContext, opts: { file?: Buffer; fileStatus?: number; truncate?: number } = {}): Promise<Fake> {
  const file = opts.file ?? Buffer.alloc(0);
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://s3");
    if (url.searchParams.get("list-type") === "2") {
      const token = url.searchParams.get("continuation-token");
      const entry = (d: string, etag: string) =>
        `<Contents><Key>${PREFIX}/trades/date=${d}/trades.parquet</Key><ETag>${etag}</ETag><Size>${file.length}</Size></Contents>`;
      res.setHeader("content-type", "application/xml");
      res.end(
        token
          ? `<ListBucketResult><IsTruncated>false</IsTruncated>${entry("2026-11-16", "&quot;e16&quot;")}</ListBucketResult>`
          : `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>tok</NextContinuationToken>` +
              `<Contents><Key>${PREFIX}/trades/</Key><ETag>&quot;x&quot;</ETag><Size>0</Size></Contents>` +
              `${entry("2026-11-14", "&quot;e14&quot;")}${entry("2026-11-15", '"e15"')}</ListBucketResult>`,
      );
      return;
    }
    if (opts.fileStatus) {
      res.statusCode = opts.fileStatus;
      res.end("boom");
      return;
    }
    res.end(opts.truncate === undefined ? file : file.subarray(0, opts.truncate));
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
  return { env: { LIGHTER_S3_URL: `http://127.0.0.1:${port}`, LIGHTER_S3_PREFIX: PREFIX }, file };
}

async function withParquet(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "lighter-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "trades.parquet");
  await writeTrades(path);
  return { dir, file: await readFile(path) };
}

const dayOf = (file: Buffer, date = "2026-11-16"): DayFile => ({
  dataset: "trades",
  date,
  key: `${PREFIX}/trades/date=${date}/trades.parquet`,
  etag: "e16",
  size: file.length,
});

test("listDays follows continuation tokens and keeps the dates in range", async (t) => {
  const { env } = await fakeS3(t, { file: Buffer.from("x") });
  const days = await listDays(env, "trades", "2026-11-15", "2026-11-16");
  assert.deepEqual(days.map((d) => [d.date, d.etag]), [["2026-11-15", "e15"], ["2026-11-16", "e16"]]);
  assert.equal(days[0]!.key, `${PREFIX}/trades/date=2026-11-15/trades.parquet`);
});

test("yields a day in chunks of rowsPerChunk rows, ids as strings, times in UTC", async (t) => {
  const { file } = await withParquet(t);
  const { env } = await fakeS3(t, { file });
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
  const failing = await fakeS3(t, { fileStatus: 500 });
  await assert.rejects(collect(readDay(failing.env, dayOf(Buffer.alloc(4096)), { tmpDir })), /date=2026-11-16.*HTTP 500/);
  const short = await fakeS3(t, { file: Buffer.alloc(4096), truncate: 100 });
  await assert.rejects(collect(readDay(short.env, dayOf(Buffer.alloc(4096)), { tmpDir })), /expected 4096 bytes/);
  assert.deepEqual(await readdir(tmpDir), []);
});

test("readDay removes its temporary folder after a successful read", async (t) => {
  const { file } = await withParquet(t);
  const { env } = await fakeS3(t, { file });
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
  const { file } = await withParquet(t);
  const { env } = await fakeS3(t, { file });
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
  const { file } = await withParquet(t);
  const { env } = await fakeS3(t, { file });
  const checkpoint = { key: "k", value: 1 };
  const batches = await collect(dayBatches(env, dayOf(file), { where: "id = 0", rowId: (r) => String(r.id), checkpoint }));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]!.records, []);
  assert.deepEqual(batches[0]!.succeededCallIds, ["trades:2026-11-16"]);
  assert.equal(batches[0]!.callsCompleted, 1);
  assert.deepEqual(batches[0]!.checkpoints, [checkpoint]);
});

test("dayBatches turns a failed day into a dead letter with no checkpoint", async (t) => {
  const { env } = await fakeS3(t, { fileStatus: 500 });
  const day = dayOf(Buffer.alloc(4096));
  const batches: Batch<DayCall>[] = await collect(
    dayBatches(env, day, { rowId: (r) => String(r.id), checkpoint: { key: "k", value: 1 } }),
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
