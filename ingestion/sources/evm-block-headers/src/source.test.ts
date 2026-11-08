import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { portalClient, type Batch, type RawRecord } from "@ingestion/lib";
import { createEvmClient } from "@ingestion/lib/evm";
import { mockPortal } from "@subsquid/pipes/testing";
import { mockBlock } from "@subsquid/pipes/testing/evm";
import { forChain, headersCallSchema, headersCallsAt, readBoundaries, type HeadersCall, type HeadersEnv } from "#src/source.ts";

const seconds = (iso: string) => Date.parse(iso) / 1000;

// B of 2026-11-05 is block 101, two seconds past midnight; B of 2026-11-06 is block 104, right on it.
// The finalized head, block 105, has not reached 2026-11-07.
const chain = [
  { number: 100, timestamp: seconds("2026-11-04T23:59:50Z") },
  { number: 101, timestamp: seconds("2026-11-05T00:00:02Z") },
  { number: 102, timestamp: seconds("2026-11-05T12:00:00Z") },
  { number: 103, timestamp: seconds("2026-11-05T23:59:59Z") },
  { number: 104, timestamp: seconds("2026-11-06T00:00:00Z") },
  { number: 105, timestamp: seconds("2026-11-06T12:00:00Z") },
].map((b) => mockBlock(b));
const header = (n: number) => chain.find((b) => b.header.number === n)!.header;

/**
 * Pipes' mock Portal, with the /timestamps route it lacks in front. The route answers `guess` of the
 * first block at or after the time, or of the head when no block has reached it. Returns the URL and
 * the midnights the route was asked for.
 */
async function portal(t: TestContext, guess: (block: number) => number = (b) => b) {
  const mock = await mockPortal({ blocks: chain });
  const asked: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const route = req.url?.match(/^\/timestamps\/(\d+)\/block$/);
    if (route) {
      const time = Number(route[1]);
      asked.push(new Date(time * 1000).toISOString());
      const first = (chain.find((b) => b.header.timestamp >= time) ?? chain.at(-1)!).header.number;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ block_number: guess(first) }));
      return;
    }
    const reply = await fetch(`${mock.url}${req.url}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "POST" ? body : undefined,
    });
    const headers = Object.fromEntries([...reply.headers].filter(([k]) => !["content-length", "content-encoding", "transfer-encoding"].includes(k)));
    res.writeHead(reply.status, headers);
    res.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await mock.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

type Request = { id: number; method: string; params: [string, boolean] };

/** A JSON-RPC node that answers eth_getBlockByNumber from `chain`, and an error for any block in `failing`. */
async function rpc(t: TestContext, failing: Set<number> = new Set()) {
  const asked: number[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const parsed = JSON.parse(body) as Request | Request[];
    const answer = ({ id, method, params: [number] }: Request) => {
      const n = Number(number);
      asked.push(n);
      if (method !== "eth_getBlockByNumber") return { jsonrpc: "2.0", id, error: { code: -32601, message: `unexpected ${method}` } };
      if (failing.has(n)) return { jsonrpc: "2.0", id, error: { code: -32000, message: "upstream timed out" } };
      const h = header(n);
      const hex = (v: number) => `0x${v.toString(16)}`;
      return { jsonrpc: "2.0", id, result: { number: hex(n), hash: h.hash, parentHash: h.parentHash, timestamp: hex(h.timestamp), transactions: [] } };
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

const env = (portalUrl: string, rpcUrl: string, overrides: Partial<HeadersEnv> = {}): HeadersEnv => ({
  PORTAL_URL: portalUrl,
  EVM_RPC_URL: rpcUrl,
  RPC_BATCH_SIZE: 10,
  RPC_MAX_CONCURRENCY: 2,
  START_DATE: "2026-11-05",
  ...overrides,
});

async function drain(batches: AsyncIterable<Batch<HeadersCall>>) {
  const all: Batch<HeadersCall> = { records: [], failed: [] };
  for await (const { records, failed } of batches) {
    all.records.push(...records);
    all.failed.push(...failed);
  }
  return all;
}

const run = (e: HeadersEnv, retry: HeadersCall[] = []) => drain(forChain("ethereum").extract(e, retry));

const headerData = (origin: string, n: number) => ({
  kind: "header",
  origin,
  number: n,
  hash: header(n).hash,
  parent_hash: header(n).parentHash,
  parent_number: n - 1,
  timestamp: new Date(header(n).timestamp * 1000).toISOString(),
});

test("each midnight the head has passed gets its boundary and the headers of B - 1 and B from Portal and the RPC", async (t) => {
  const [p, r] = [await portal(t), await rpc(t)];
  const { records, failed } = await run(env(p.url, r.url));

  assert.deepEqual(failed, []);
  const m = "2026-11-06T00:00:00.000Z";
  const byId = (r: RawRecord) => r.id;
  assert.deepEqual(
    records.filter((r) => r.callId === m).sort((a, b) => byId(a).localeCompare(byId(b))),
    [
      { id: `boundary:${m}`, callId: m, data: { kind: "boundary", midnight: m, block: 104 } },
      { id: "portal:103", callId: m, data: headerData("portal", 103) },
      { id: "portal:104", callId: m, data: headerData("portal", 104) },
      { id: "rpc:103", callId: m, data: headerData("rpc", 103) },
      { id: "rpc:104", callId: m, data: headerData("rpc", 104) },
    ],
  );
  assert.deepEqual(
    records.filter((r) => r.id.startsWith("boundary:")).map((r) => [r.callId, r.data.block]),
    [
      ["2026-11-05T00:00:00.000Z", 101],
      ["2026-11-06T00:00:00.000Z", 104],
    ],
  );
  assert.deepEqual(p.asked.sort(), ["2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z"], "2026-11-07, past the head, is never asked for");
  assert.deepEqual([...new Set(r.asked)].sort(), [100, 101, 103, 104]);
});

test("B is the first block at or after midnight by Portal's headers, however far off the timestamps route is", async (t) => {
  const r = await rpc(t);
  for (const [label, guess] of [
    ["late", (b: number) => b + 3],
    ["early", (b: number) => b - 4],
    ["far early", () => 0],
    ["past the head", () => 1_000],
  ] as const) {
    const p = await portal(t, guess);
    const { records } = await run(env(p.url, r.url));
    assert.deepEqual(
      records.filter((r) => r.id.startsWith("boundary:")).map((r) => r.data.block),
      [101, 104],
      label,
    );
  }
});

test("a midnight whose RPC read fails becomes a dead letter keyed by its midnight, and its retry succeeds", async (t) => {
  const p = await portal(t);
  const failing = await rpc(t, new Set([104]));
  const head = 105;
  const calls = headersCallsAt(["2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z"]);
  const first = await drain(readBoundaries(portalClient(p.url), createEvmClient(failing.url, { retryCount: 0 }), head, calls));

  const m = "2026-11-06T00:00:00.000Z";
  assert.deepEqual(first.failed.map(({ id, call }) => ({ id, call })), [{ id: m, call: { kind: "block_headers", midnight: m } }]);
  assert.equal(first.records.some((r) => r.callId === m), false, "no partial midnight: none of its records is written");
  assert.equal(first.records.filter((r) => r.callId === "2026-11-05T00:00:00.000Z").length, 5, "the other midnight still loads");

  const healthy = await rpc(t);
  const retry = [headersCallSchema.parse(first.failed[0]!.call)];
  const again = await run(env(p.url, healthy.url, { END_DATE: "2026-11-05" }), retry);
  assert.deepEqual(again.failed, []);
  assert.deepEqual(
    again.records.filter((r) => r.callId === m).map((r) => r.id).sort(),
    [`boundary:${m}`, "portal:103", "portal:104", "rpc:103", "rpc:104"],
    "the retried midnight loads, though END_DATE alone would leave it out",
  );
});

test("a rerun writes the same ids and the same records", async (t) => {
  const [p, r] = [await portal(t), await rpc(t)];
  const first = await run(env(p.url, r.url));
  const again = await run(env(p.url, r.url));
  assert.deepEqual(again, first);
  assert.equal(new Set(first.records.map((r) => r.id)).size, first.records.length, "no id repeats within a run");
});

test("each chain loads into a table of its own, and END_DATE cannot come before START_DATE", () => {
  const source = forChain("ethereum");
  assert.equal(source.name, "ethereum", "runSource writes to raw.ethereum_block_headers");
  assert.equal(source.table, "block_headers");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
  const base = { PORTAL_URL: "http://127.0.0.1:1", EVM_RPC_URL: "http://127.0.0.1:2", START_DATE: "2026-11-06" };
  assert.match(source.env.safeParse({ ...base, END_DATE: "2026-11-05" }).error!.message, /END_DATE must not be before START_DATE/);
  assert.equal(source.env.safeParse({ ...base, START_DATE: "2026-11-6" }).success, false);
  assert.equal(source.call.safeParse({ kind: "block_headers", midnight: "2026-11-06T00:00:01.000Z" }).success, false, "a dead letter that names no midnight is parked");
});
