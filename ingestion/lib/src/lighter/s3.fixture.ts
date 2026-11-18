import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { LighterDataset, LighterS3Env } from "#src/lighter/s3.ts";

/** The prefix the fake bucket serves its datasets under. */
export const PREFIX = "v1.1/lighter/core/mainnet";
const FILE_NAMES = { trades: "trades.parquet", open_interest_hourly: "oi.parquet" } as const;
// What S3 lists for an empty object, such as the dataset's folder key.
const EMPTY_ETAG = "d41d8cd98f00b204e9800998ecf8427e";

/** The bytes of a Parquet file that DuckDB writes from `select`, with times in UTC. */
export async function parquetFile(t: TestContext, select: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "lighter-parquet-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "day.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  try {
    const connection = await instance.connect();
    try {
      await connection.run("SET TimeZone = 'UTC'");
      await connection.run(`COPY (${select}) TO '${path.replaceAll("'", "''")}' (FORMAT parquet, COMPRESSION zstd)`);
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
  return readFile(path);
}

/** A reply in place of the real one: a status, the real body cut to half, or headers and then no body. */
export type Reply = { status: number; headers?: Record<string, string>; body?: string } | "short" | "stall";

export type FakeBucket = {
  /** The settings that point the code under test at this bucket. */
  env: LighterS3Env;
  /** Every request's path and query, in order. */
  requests: string[];
  /** How many listing pages the bucket was asked for. */
  lists: number;
  /** The date of each download, in order. */
  downloads: string[];
  /** The day files the bucket lists and serves, by date. */
  files: Map<string, Buffer>;
  /** The ETag listed for a date, when set here; otherwise `etag-<date>`. */
  etags: Map<string, string>;
  /** Dates whose download answers HTTP 500. */
  broken: Set<string>;
  /** Keys per listing page. A longer listing hands out continuation tokens. */
  pageSize: number;
  /** Listings after this many answer HTTP 503. */
  listsBeforeOutage: number;
  /** Replies for the next listings, one each, before the outage and the real pages. */
  listReplies: Reply[];
  /** Replies for the next downloads, one each, before `broken` and the real files. */
  downloadReplies: Reply[];
};

/**
 * A fake of Lighter's S3 bucket for one dataset: ListObjectsV2 listings of its day files, and the files.
 * A test changes the fields to change what the bucket lists and how it answers.
 */
export async function fakeBucket(t: TestContext, dataset: LighterDataset, files: Record<string, Buffer>): Promise<FakeBucket> {
  const folder = `${PREFIX}/${dataset}/`;
  const keyOf = (date: string) => `${folder}date=${date}/${FILE_NAMES[dataset]}`;

  const page = (query: URLSearchParams): Buffer => {
    // The real bucket lists the dataset's folder as a key of its own, ahead of the day files.
    const entries = [
      { key: folder, etag: EMPTY_ETAG, size: 0 },
      ...[...bucket.files].map(([date, file]) => ({ key: keyOf(date), etag: bucket.etags.get(date) ?? `etag-${date}`, size: file.length })),
    ]
      .filter((entry) => entry.key.startsWith(query.get("prefix") ?? ""))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const start = Number(query.get("continuation-token") ?? 0);
    const end = start + bucket.pageSize;
    const next = end < entries.length ? `<NextContinuationToken>${end}</NextContinuationToken>` : "";
    const contents = entries
      .slice(start, end)
      .map((e) => `<Contents><Key>${e.key}</Key><ETag>&quot;${e.etag}&quot;</ETag><Size>${e.size}</Size></Contents>`)
      .join("");
    return Buffer.from(`<ListBucketResult><IsTruncated>${next !== ""}</IsTruncated>${next}${contents}</ListBucketResult>`);
  };

  const server = createServer((req, res) => {
    bucket.requests.push(req.url!);
    const url = new URL(req.url!, "http://s3");
    if (url.searchParams.get("list-type") === "2") {
      const outage = bucket.lists++ >= bucket.listsBeforeOutage;
      res.setHeader("content-type", "application/xml");
      send(res, bucket.listReplies.shift() ?? (outage ? { status: 503 } : undefined), page(url.searchParams));
      return;
    }
    const key = url.pathname.slice(1);
    const date = key.match(/date=(\d{4}-\d{2}-\d{2})\//)?.[1] ?? key;
    bucket.downloads.push(date);
    const reply = bucket.downloadReplies.shift() ?? (bucket.broken.has(date) ? { status: 500 } : undefined);
    send(res, reply, key === keyOf(date) ? bucket.files.get(date) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const bucket: FakeBucket = {
    env: { LIGHTER_S3_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, LIGHTER_S3_PREFIX: PREFIX },
    requests: [],
    lists: 0,
    downloads: [],
    files: new Map(Object.entries(files)),
    etags: new Map(),
    broken: new Set(),
    pageSize: Infinity,
    listsBeforeOutage: Infinity,
    listReplies: [],
    downloadReplies: [],
  };
  return bucket;
}

/** Answers with `reply`, else with `body`, else 404 as S3 does for a missing key. */
function send(res: ServerResponse, reply: Reply | undefined, body: Buffer | undefined) {
  if (reply === "stall") {
    res.writeHead(200, { "content-length": String(body?.length || 1) }).flushHeaders();
  } else if (reply === "short") {
    res.end(body?.subarray(0, body.length >> 1));
  } else if (reply) {
    res.writeHead(reply.status, reply.headers).end(reply.body ?? "");
  } else if (body) {
    res.end(body);
  } else {
    res.writeHead(404).end();
  }
}
