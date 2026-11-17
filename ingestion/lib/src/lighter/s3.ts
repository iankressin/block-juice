import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { DuckDBInstance } from "@duckdb/node-api";
import * as z from "zod";
import { describeError, logger, observedFetch, observeDelay } from "@ingestion/lib";
import { RETRY_AFTER_CAP_MS, retryAfterMs, systemClock, type Clock } from "#src/lighter/client.ts";
import type { Batch, Checkpoint, RawRecord } from "#src/source.ts";

// Lighter publishes one Parquet file per UTC day on a public bucket: catalog/vendors/lighter/NOTES.md, "S3 files".
export const lighterS3Env = z.object({
  LIGHTER_S3_URL: z.url().default("https://aws-public-blockchain.s3.amazonaws.com"),
  LIGHTER_S3_PREFIX: z.string().default("v1.1/lighter/core/mainnet"),
});

export type LighterS3Env = z.infer<typeof lighterS3Env>;

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
/** The waits before each retry of a 429, a 5xx, a network error, a timeout or a short download. */
export const S3_RETRY_WAITS_MS = [2_000, 10_000, 60_000];
/** More listing pages than this means the listing loops. */
export const S3_MAX_LIST_PAGES = 1_000;

/** A failure that already knows whether a retry can help, and what `Retry-After` asked. */
class S3Error extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryable: boolean, retryAfter?: number) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfter;
  }
}

/** The error for a reply that is not a 200. A 429 and a 5xx can pass on a retry; any other 4xx cannot. */
function httpError(what: string, response: Response, clock: Clock): S3Error {
  const { status } = response;
  const retryable = status === 429 || status >= 500;
  return new S3Error(
    `Lighter S3 ${what} answered HTTP ${status}`,
    retryable,
    retryable ? retryAfterMs(response.headers.get("retry-after"), clock.now()) : undefined,
  );
}

/** Runs `attempt` again after a retryable failure, waiting as `S3_RETRY_WAITS_MS` says, then throws the last failure. */
async function withRetries<T>(what: string, clock: Clock, attempt: () => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const scheduledMs = S3_RETRY_WAITS_MS[n];
      if ((error instanceof S3Error && !error.retryable) || scheduledMs === undefined) throw error;
      const asked = error instanceof S3Error ? error.retryAfterMs : undefined;
      const waitMs = asked === undefined ? scheduledMs : Math.min(asked, RETRY_AFTER_CAP_MS);
      logger.info({ what, error: describeError(error), waitMs }, "Lighter S3 failed a request, waiting before trying again");
      await observeDelay(() => clock.sleep(waitMs));
    }
  }
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
    const xml = await withRetries(`list of ${dataset}`, clock, async () => {
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
  await withRetries(file.key, clock, async () => {
    const response = await observedFetch(`${env.LIGHTER_S3_URL}/${file.key}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(file.key, response, clock);
    }
    // createWriteStream opens with "w", which empties a file that an earlier attempt left.
    await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(path));
    const { size } = await stat(path);
    if (size !== file.size) throw new S3Error(`Lighter S3 ${file.key} gave ${size} bytes, expected ${file.size} bytes`, true);
  });
}

/**
 * One day file as chunks of rows. It downloads the file to a temporary folder, then lets DuckDB read
 * it with a memory cap, so memory stays flat. 64-bit integers come as strings and times in UTC.
 * `where` is trusted SQL: callers build it only from validated integers.
 */
export async function* readDay(
  env: LighterS3Env,
  file: DayFile,
  options: { where?: string; rowsPerChunk?: number; tmpDir?: string; clock?: Clock; downloadTimeoutMs?: number } = {},
): AsyncGenerator<Record<string, unknown>[]> {
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
 * Which day files still need a load. A day is done when the saved manifest holds its ETag.
 * `loaded(day)` gives the checkpoint that records it, next to every day recorded before.
 */
export function dayManifest(key: string, saved: unknown, days: readonly DayFile[]) {
  const files: Record<string, string> = { ...(manifestSchema.safeParse(saved).data?.files ?? {}) };
  return {
    pending: days.filter((day) => files[day.date] !== day.etag),
    loaded(day: DayFile): Checkpoint {
      files[day.date] = day.etag;
      return { key, value: { files: { ...files } } };
    },
  };
}

/**
 * One day as batches. It reads a chunk ahead, so each batch but the last gives its records the call id
 * `<dataset>:<date>#<n>`. The last gives them the day's id and clears its dead letter, and holds the
 * checkpoint, so a day that fails halfway records nothing and its retry rewrites the chunks by id.
 */
export async function* dayBatches(
  env: LighterS3Env,
  file: DayFile,
  options: {
    where?: string;
    rowId(row: Record<string, unknown>): string;
    checkpoint: Checkpoint;
    rowsPerChunk?: number;
    clock?: Clock;
    downloadTimeoutMs?: number;
  },
): AsyncGenerator<Batch<DayCall>> {
  const id = `${file.dataset}:${file.date}`;
  const records = (rows: Record<string, unknown>[], callId: string): RawRecord[] =>
    rows.map((data) => ({ id: options.rowId(data), callId, data }));
  const readOptions = {
    ...(options.where ? { where: options.where } : {}),
    ...(options.rowsPerChunk ? { rowsPerChunk: options.rowsPerChunk } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.downloadTimeoutMs ? { downloadTimeoutMs: options.downloadTimeoutMs } : {}),
  };
  try {
    let ahead: Record<string, unknown>[] | undefined;
    let n = 0;
    for await (const rows of readDay(env, file, readOptions)) {
      // 0, so the run does not count each chunk id as a call: only the last batch completes the day.
      if (ahead) yield { records: records(ahead, `${id}#${n++}`), failed: [], callsCompleted: 0 };
      ahead = rows;
    }
    yield {
      records: records(ahead ?? [], id),
      failed: [],
      succeededCallIds: [id],
      callsCompleted: 1,
      checkpoints: [options.checkpoint],
    };
  } catch (error) {
    yield { records: [], failed: [{ id, call: { date: file.date, etag: file.etag }, error: describeError(error) }], callsCompleted: 1 };
  }
}
