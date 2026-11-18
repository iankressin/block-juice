import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { DuckDBInstance } from "@duckdb/node-api";
import * as z from "zod";
import { describeError } from "#src/calls.ts";
import { retryAfterMs, systemClock, type Clock } from "#src/clock.ts";
import { DAY_MS, historyKey } from "#src/history.ts";
import { LighterError, withRetries } from "#src/lighter/retry.ts";
import { observedFetch } from "#src/transport-metrics.ts";
import type { Batch, Checkpoint, ExtractionContext } from "#src/source.ts";

// Lighter publishes one Parquet file per UTC day on a public bucket: catalog/vendors/lighter/NOTES.md, "S3 files".
export const lighterS3Env = z.object({
  LIGHTER_S3_URL: z.url().default("https://aws-public-blockchain.s3.amazonaws.com"),
  LIGHTER_S3_PREFIX: z.string().default("v1.1/lighter/core/mainnet"),
});

export type LighterS3Env = z.infer<typeof lighterS3Env>;

/** The settings of a source that loads day files with `loadDays`: the bucket, the first day and the last. */
export const lighterDaysEnv = lighterS3Env
  .extend({ START_DATE: z.iso.date(), END_DATE: z.iso.date().optional() })
  .refine((env) => !env.END_DATE || env.END_DATE >= env.START_DATE, {
    path: ["END_DATE"],
    message: "END_DATE may not come before START_DATE",
  });

export type LighterDaysEnv = z.infer<typeof lighterDaysEnv>;

export type LighterDataset = "trades" | "open_interest_hourly";

const FILE_NAMES = { trades: "trades.parquet", open_interest_hourly: "oi.parquet" } as const;

export type DayFile = { dataset: LighterDataset; date: string; key: string; etag: string; size: number };

/** What a retry needs to read one day again. */
export type DayCall = { date: string; etag: string };

export const dayCallSchema: z.ZodType<DayCall> = z.object({ date: z.string(), etag: z.string() });

/** The longest one listing page may take, body included. */
export const S3_LIST_TIMEOUT_MS = 60_000;
/** The longest one day-file download may take, body included. */
export const S3_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** More listing pages than this means the listing loops. */
export const S3_MAX_LIST_PAGES = 1_000;

/** The error for a reply that is not a 200. A 429 and a 5xx can pass on a retry; any other 4xx cannot. */
function httpError(what: string, response: Response, clock: Clock): LighterError {
  const { status } = response;
  const retryable = status === 429 || status >= 500;
  return new LighterError(`Lighter S3 ${what} answered HTTP ${status}`, retryable, {
    status,
    retryAfterMs: retryable ? retryAfterMs(response.headers.get("retry-after"), clock.now()) : undefined,
  });
}

const xmlText = (s: string) =>
  s.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];

/**
 * The day files of `dataset` from `from` to `to`, both included, oldest first.
 * Each page is retried on its own; a listing that loops or ends without a token it promised throws.
 */
export async function listDays(
  env: LighterS3Env,
  dataset: LighterDataset,
  from: string,
  to: string,
  clock: Clock = systemClock,
  timeoutMs = S3_LIST_TIMEOUT_MS,
): Promise<DayFile[]> {
  const fileName = FILE_NAMES[dataset];
  const days: DayFile[] = [];
  const usedTokens = new Set<string>();
  let token: string | undefined;
  for (let page = 1; ; page++) {
    if (page > S3_MAX_LIST_PAGES) throw new Error(`Lighter S3 list of ${dataset} ran past ${S3_MAX_LIST_PAGES} pages`);
    const query = new URLSearchParams({ "list-type": "2", prefix: `${env.LIGHTER_S3_PREFIX}/${dataset}/` });
    if (token) query.set("continuation-token", token);
    const xml = await withRetries(`S3 list of ${dataset}`, clock, async () => {
      const response = await observedFetch(`${env.LIGHTER_S3_URL}/?${query}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw httpError(`list of ${dataset}`, response, clock);
      }
      return response.text();
    });
    for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlText(tag(item!, "Key") ?? "");
      const date = key.match(/date=(\d{4}-\d{2}-\d{2})\/[^/]+$/)?.[1];
      if (!date || !key.endsWith(`/${fileName}`) || date < from || date > to) continue;
      const etag = xmlText(tag(item!, "ETag") ?? "").replaceAll('"', "");
      days.push({ dataset, date, key, etag, size: Number(tag(item!, "Size")) });
    }
    if (tag(xml, "IsTruncated") !== "true") break;
    const next = xmlText(tag(xml, "NextContinuationToken") ?? "");
    if (!next) throw new Error(`Lighter S3 list of ${dataset} is truncated but gave no continuation token`);
    if (usedTokens.has(next)) throw new Error(`Lighter S3 list of ${dataset} repeated a continuation token`);
    usedTokens.add(next);
    token = next;
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Streams the file to `path`, so a 200 MB day never sits in memory, and checks the byte count.
 * A retry writes the file again from the start. The deadline covers the whole body.
 */
async function download(env: LighterS3Env, file: DayFile, path: string, clock: Clock, timeoutMs: number): Promise<void> {
  await withRetries(`S3 ${file.key}`, clock, async () => {
    const response = await observedFetch(`${env.LIGHTER_S3_URL}/${file.key}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(file.key, response, clock);
    }
    // createWriteStream opens with "w", which empties a file that an earlier attempt left.
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(path));
    const { size } = await stat(path);
    if (size !== file.size) throw new LighterError(`Lighter S3 ${file.key} gave ${size} bytes, expected ${file.size} bytes`, true);
  });
}

type ReadDayOptions = { where?: string; rowsPerChunk?: number; tmpDir?: string; clock?: Clock; downloadTimeoutMs?: number };

/**
 * One day file as chunks of rows. It downloads the file to a temporary folder, then lets DuckDB read
 * it with a memory cap, so memory stays flat. 64-bit integers come as strings and times in UTC.
 * `where` is trusted SQL: callers build it only from validated integers.
 */
export async function* readDay(env: LighterS3Env, file: DayFile, options: ReadDayOptions = {}): AsyncGenerator<Record<string, unknown>[]> {
  const { where, rowsPerChunk = 10_000, tmpDir = tmpdir(), clock = systemClock, downloadTimeoutMs = S3_DOWNLOAD_TIMEOUT_MS } = options;
  const folder = await mkdtemp(join(tmpDir, "lighter-"));
  try {
    const path = join(folder, "day.parquet");
    await download(env, file, path, clock, downloadTimeoutMs);
    const instance = await DuckDBInstance.create(":memory:");
    try {
      const connection = await instance.connect();
      try {
        await connection.run("SET memory_limit = '512MB'");
        await connection.run("SET threads = 2");
        await connection.run("SET TimeZone = 'UTC'");
        const source = `read_parquet('${path.replaceAll("'", "''")}')`;
        // The JSON reader prints a timestamptz in the process's zone and ignores TimeZone, so cast those columns.
        const columns = (await connection.runAndReadAll(`select column_name, column_type from (describe select * from ${source})`)).getRowObjectsJson();
        const casts = columns
          .filter((c) => c.column_type === "TIMESTAMP WITH TIME ZONE")
          .map((c) => `"${String(c.column_name).replaceAll('"', '""')}"::varchar as "${String(c.column_name).replaceAll('"', '""')}"`);
        const select = casts.length ? `* replace (${casts.join(", ")})` : "*";
        const filter = where ? ` where ${where}` : "";
        const result = await connection.stream(`select ${select} from ${source}${filter}`);
        let pending: Record<string, unknown>[] = [];
        for await (const rows of result.yieldRowObjectJson()) {
          pending.push(...rows);
          while (pending.length >= rowsPerChunk) {
            yield pending.slice(0, rowsPerChunk);
            pending = pending.slice(rowsPerChunk);
          }
        }
        if (pending.length) yield pending;
      } finally {
        connection.closeSync();
      }
    } finally {
      instance.closeSync();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const manifestSchema = z.object({ files: z.record(z.string(), z.string()) });

/**
 * The ETag of each day the source has tried, saved as a checkpoint under `key`. A saved value of
 * another shape counts as empty. `record(day)` adds the day and gives the checkpoint that saves it,
 * next to every day recorded before.
 */
function dayManifest(key: string, saved: unknown) {
  const files: Record<string, string> = { ...(manifestSchema.safeParse(saved).data?.files ?? {}) };
  return {
    holds: (day: DayFile) => files[day.date] === day.etag,
    record(day: DayFile): Checkpoint {
      files[day.date] = day.etag;
      return { key, value: { files: { ...files } } };
    },
  };
}

/** One day as a batch per chunk of rows, then a closing batch that ends the day's call and records it. */
async function* dayBatches(
  env: LighterS3Env,
  file: DayFile,
  manifest: ReturnType<typeof dayManifest>,
  rowId: (row: Record<string, unknown>) => string,
  read: ReadDayOptions,
): AsyncGenerator<Batch<DayCall>> {
  const id = `${file.dataset}:${file.date}`;
  let end: Pick<Batch<DayCall>, "failed" | "succeededCallIds">;
  try {
    let n = 0;
    for await (const rows of readDay(env, file, read)) {
      const callId = `${id}#${n++}`;
      // 0, so the run counts the day once, at its closing batch.
      yield { records: rows.map((data) => ({ id: rowId(data), callId, data })), failed: [], callsCompleted: 0 };
    }
    end = { failed: [], succeededCallIds: [id] };
  } catch (error) {
    end = { failed: [{ id, call: { date: file.date, etag: file.etag }, error: describeError(error) }] };
  }
  yield { records: [], ...end, callsCompleted: 1, checkpoints: [manifest.record(file)] };
}

/**
 * Loads the day files of `dataset` as a call source's batches. Each day is one call, id `<dataset>:<date>`.
 *
 * - The last day is `END_DATE`, or yesterday in UTC when it is unset: Lighter writes a day's file about
 *   07:03 UTC the next day.
 * - A manifest of day ETags, saved as a checkpoint, keeps the days the source has tried. Its key names
 *   the bucket, the dataset and `keyParts`, so a source that filters rows passes its filter there. A day
 *   from `START_DATE` to the last day is pending when the manifest lacks its ETag.
 * - A run lists the bucket once, over the pending days and the retried dates. A retried date reads its
 *   current file from that listing, and fails again when the file has gone. A failed listing fails the run.
 * - Days load oldest first, one at a time. A chunk's records carry the call id `<dataset>:<date>#<n>`, so
 *   no chunk clears the day's dead letter. A closing batch with no records clears it, or holds the failure.
 *   A day that fails halfway keeps the chunks it wrote, and its retry rewrites them by row id.
 * - The closing batch records the day in the manifest, whether it loaded or failed, so a failed day's
 *   checkpoint and dead letter commit together. Only the dead letter brings a failed day back, as in the
 *   history sources. Once the framework parks it (five failed runs), the day loads again only when its
 *   ETag changes.
 */
export async function* loadDays(
  env: LighterDaysEnv,
  retry: readonly DayCall[],
  context: ExtractionContext<DayCall> | undefined,
  options: ReadDayOptions & { dataset: LighterDataset; keyParts?: unknown[]; rowId(row: Record<string, unknown>): string },
): AsyncGenerator<Batch<DayCall>> {
  const { dataset, keyParts = [], rowId, clock = systemClock, ...read } = options;
  const last = env.END_DATE ?? new Date(clock.now() - DAY_MS).toISOString().slice(0, 10);
  const retried = new Map(retry.map((call) => [call.date, call]));
  const retriedDates = [...retried.keys()];
  const from = retriedDates.reduce((min, date) => (date < min ? date : min), env.START_DATE);
  const to = retriedDates.reduce((max, date) => (date > max ? date : max), last);
  const listed = await listDays(env, dataset, from, to, clock);
  const key = historyKey(["lighter", env.LIGHTER_S3_URL, env.LIGHTER_S3_PREFIX, dataset, ...keyParts]);
  const manifest = dayManifest(key, await context?.getCheckpoint?.(key));

  const listedDates = new Set(listed.map((day) => day.date));
  for (const [date, call] of retried) {
    if (listedDates.has(date)) continue;
    const error = `Lighter S3 has no ${dataset} file for ${date}`;
    yield { records: [], failed: [{ id: `${dataset}:${date}`, call, error }], callsCompleted: 1 };
  }
  const days = listed.filter(
    (day) => retried.has(day.date) || (day.date >= env.START_DATE && day.date <= last && !manifest.holds(day)),
  );
  for (const day of days) yield* dayBatches(env, day, manifest, rowId, { ...read, clock });
}
