import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Batch } from "@ingestion/lib";
import { tronBlockHeaders, type TronBlockHeadersEnv } from "#src/source.ts";

type MidnightCall = { midnight: string };

// A chain of 3-second blocks in which block 1,000 is the first of 2026-11-05 (1 s after midnight)
// and block 29,800 the first of 2026-11-06. Portal's finalized head is block 40,000, on 2026-11-06.
const NOV_5_MS = Date.UTC(2026, 10, 5);
const HEAD = 40_000;
const timestampMs = (n: number) => NOV_5_MS + 1_000 + (n - 1_000) * 3_000;
const hash = (n: number) => n.toString(16).padStart(64, "0");
// Portal's timestamps route answers this many blocks early, as it does on TRON.
const GUESS_EARLY_BLOCKS = 300;

type Fake = {
  url: string;
  /** Blocks TronGrid answers 500 for, until removed. */
  failing: Set<number>;
  tronRequests: { num: number; apiKey: string | undefined }[];
};

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => resolve(text));
  });

/** Portal under /portal and TronGrid under /tron, both serving the chain above. */
async function fake(t: TestContext): Promise<Fake> {
  const failing = new Set<number>();
  const tronRequests: Fake["tronRequests"] = [];
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const server = createServer(async (req, res) => {
    const path = req.url ?? "";
    const text = await body(req);
    const at = /^\/portal\/timestamps\/(\d+)\/block$/.exec(path);
    if (path === "/portal/finalized-head") {
      return json(res, 200, { number: HEAD, hash: hash(HEAD) });
    }
    if (at) {
      const first = Math.ceil((Number(at[1]) * 1000 - timestampMs(0)) / 3_000);
      return json(res, 200, { block_number: first - GUESS_EARLY_BLOCKS });
    }
    if (path === "/portal/finalized-stream") {
      const { fromBlock, toBlock } = JSON.parse(text) as { fromBlock: number; toBlock: number };
      res.writeHead(200, {
        "content-type": "application/jsonl",
        "X-Sqd-Finalized-Head-Number": HEAD,
      });
      for (let n = fromBlock; n <= Math.min(toBlock, HEAD); n++) {
        const header = { number: n, hash: hash(n), parentHash: hash(n - 1) };
        res.write(`${JSON.stringify({ header: { ...header, timestamp: timestampMs(n) } })}\n`);
      }
      return res.end();
    }
    if (path === "/tron/wallet/getblockbynum") {
      const { num } = JSON.parse(text) as { num: number };
      const apiKey = req.headers["tron-pro-api-key"];
      tronRequests.push({ num, apiKey: typeof apiKey === "string" ? apiKey : undefined });
      if (failing.has(num)) return json(res, 500, { Error: "busy" });
      const raw_data = { number: num, timestamp: timestampMs(num), parentHash: hash(num - 1) };
      return json(res, 200, { blockID: hash(num), block_header: { raw_data } });
    }
    json(res, 404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, failing, tronRequests };
}

const env = (url: string, overrides: Partial<TronBlockHeadersEnv> = {}): TronBlockHeadersEnv => ({
  PORTAL_URL: `${url}/portal`,
  TRON_HTTP_URL: `${url}/tron`,
  TRON_HTTP_INTERVAL_MS: 0,
  START_DATE: "2026-11-05",
  ...overrides,
});

async function run(settings: TronBlockHeadersEnv, retry: MidnightCall[] = []) {
  const batch: Required<Batch<MidnightCall>> = { records: [], failed: [], succeededCallIds: [] };
  for await (const { records, failed } of tronBlockHeaders.extract(settings, retry)) {
    batch.records.push(...records);
    batch.failed.push(...failed);
  }
  return batch;
}

const header = (origin: string, n: number) => ({
  kind: "header",
  origin,
  number: n,
  hash: hash(n),
  parent_hash: hash(n - 1),
  parent_number: n - 1,
  timestamp: new Date(timestampMs(n)).toISOString(),
});

test("each midnight the head passed gets its first block and both origins' headers", async (t) => {
  const { url } = await fake(t);
  const { records, failed } = await run(env(url));
  assert.deepEqual(failed, []);
  const [nov5, nov6] = ["2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z"];
  assert.deepEqual(
    records.filter((record) => record.callId === nov5).map(({ id, data }) => ({ id, ...data })),
    [
      { id: `boundary:${nov5}`, kind: "boundary", midnight: nov5, block: 1_000 },
      { id: "portal:999", ...header("portal", 999) },
      { id: "portal:1000", ...header("portal", 1_000) },
      { id: "rpc:999", ...header("rpc", 999) },
      { id: "rpc:1000", ...header("rpc", 1_000) },
    ],
    `block 1000 is the first at or after midnight though Portal's route guessed block 700`,
  );
  assert.deepEqual(
    [...new Set(records.map((record) => record.callId))],
    [nov5, nov6],
    "2026-11-07 is past the head's time, so it waits",
  );
  const boundary = records.find((record) => record.id === `boundary:${nov6}`);
  assert.equal(boundary?.data.block, 29_800);
});

test("a failed TronGrid call waits as a dead letter keyed by its midnight", async (t) => {
  const fakes = await fake(t);
  const nov6 = "2026-11-06T00:00:00.000Z";
  fakes.failing.add(29_800);
  const first = await run(env(fakes.url));
  assert.equal(fakes.tronRequests.filter((r) => r.num === 29_800).length, 5, "tried five times");
  assert.deepEqual(
    first.failed.map(({ id, call }) => ({ id, call })),
    [{ id: nov6, call: { midnight: nov6 } }],
  );
  assert.match(first.failed[0]!.error, /TronGrid failed 5 times for block 29800: HTTP 500/);
  assert.equal(first.records.filter((record) => record.callId === nov6).length, 0, "no half a day");

  fakes.failing.clear();
  const call = tronBlockHeaders.call.parse(first.failed[0]!.call);
  const retried = await run(env(fakes.url, { END_DATE: "2026-11-05" }), [call]);
  assert.deepEqual(retried.failed, []);
  assert.deepEqual(
    retried.records.filter((record) => record.callId === nov6).map((record) => record.id),
    [`boundary:${nov6}`, "portal:29799", "portal:29800", "rpc:29799", "rpc:29800"],
  );
});

test("a rerun writes the same ids and rows", async (t) => {
  const { url } = await fake(t);
  const settings = env(url, { END_DATE: "2026-11-05" });
  assert.deepEqual((await run(settings)).records, (await run(settings)).records);
});

test("TRON_API_KEY goes to TronGrid as TRON-PRO-API-KEY", async (t) => {
  const fakes = await fake(t);
  await run(env(fakes.url, { END_DATE: "2026-11-05", TRON_API_KEY: "test-key" }));
  assert.ok(fakes.tronRequests.length > 0);
  assert.ok(fakes.tronRequests.every((r) => r.apiKey === "test-key"));
});

test("more than 1,000 midnights in one run fail it", async (t) => {
  const { url } = await fake(t);
  await assert.rejects(
    run(env(url, { START_DATE: "2023-01-01" })),
    /midnights from 2023-01-01, more than 1000/,
  );
});

test("the source loads raw.tron_block_headers and refuses END_DATE before START_DATE", () => {
  assert.equal(tronBlockHeaders.name, "tron");
  assert.equal(tronBlockHeaders.table, "block_headers");
  const parsed = tronBlockHeaders.env.safeParse({
    PORTAL_URL: "http://127.0.0.1:1",
    TRON_HTTP_URL: "http://127.0.0.1:1",
    START_DATE: "2026-10-08",
    END_DATE: "2026-10-07",
  });
  assert.match(parsed.error!.message, /END_DATE must not be before START_DATE/);
  const call = tronBlockHeaders.call.safeParse({ midnight: "2026-10-08T00:00:01.000Z" });
  assert.equal(call.success, false, "a dead letter that names no midnight is parked");
  assert.deepEqual(tronBlockHeaders.call.parse({ midnight: "2026-10-08T00:00:00Z" }), {
    midnight: "2026-10-08T00:00:00.000Z",
  });
});
