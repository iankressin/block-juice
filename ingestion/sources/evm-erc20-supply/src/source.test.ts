import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { portalClient, type Batch } from "@ingestion/lib";
import { createEvmClient } from "@ingestion/lib/evm";
import { mockPortal } from "@subsquid/pipes/testing";
import { mockBlock } from "@subsquid/pipes/testing/evm";
import {
  decodeAbiParameters,
  decodeFunctionData,
  deploylessCallViaBytecodeBytecode,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  type Hex,
} from "viem";
import addresses from "../chains/ethereum/addresses.json" with { type: "json" };
import { forChain, readSupply, supplyCallSchema, supplyCallsAt, type SupplyCall, type SupplyEnv } from "#src/source.ts";

const tether = addresses.tokens[0]!.toLowerCase() as Hex;
const unborn = "0x00000000000000000000000000000000000000cc";
const seconds = (iso: string) => Date.parse(iso) / 1000;

// B of 2026-11-05 is block 101 and B of 2026-11-06 is block 104, so the reads land on 100 and 103.
// The finalized head, block 105, has not reached 2026-11-07.
const chain = [
  { number: 100, timestamp: seconds("2026-11-04T23:59:50Z") },
  { number: 101, timestamp: seconds("2026-11-05T00:00:02Z") },
  { number: 102, timestamp: seconds("2026-11-05T12:00:00Z") },
  { number: 103, timestamp: seconds("2026-11-05T23:59:59Z") },
  { number: 104, timestamp: seconds("2026-11-06T00:00:00Z") },
  { number: 105, timestamp: seconds("2026-11-06T12:00:00Z") },
].map((b) => mockBlock(b));

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

type Aggregate3Call = { target: Hex; callData: Hex };

/** createEvmClient sends each batch as a deployless call: the deployer bytecode, then abi-encoded (code, aggregate3 calldata). */
function aggregate3Calls(data: Hex): readonly Aggregate3Call[] {
  const [, calldata] = decodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes" }],
    `0x${data.slice(deploylessCallViaBytecodeBytecode.length)}`,
  );
  const decoded = decodeFunctionData({ abi: multicall3Abi, data: calldata });
  if (decoded.functionName !== "aggregate3") throw new Error(`unexpected ${decoded.functionName}`);
  return decoded.args[0];
}

// Tether's supply at a block is 10^12 plus the block number, so a read at the wrong block shows. `unborn`
// has no code yet and answers nothing.
const supplyAt = (block: number) => 10n ** 12n + BigInt(block);

/**
 * A JSON-RPC node that answers each Multicall3 eth_call for Tether, or fails the whole request when
 * `failing` is set. Returns its URL and the block of every eth_call it got.
 */
async function rpc(t: TestContext, failing = false) {
  const blocks: number[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const answer = ({ id, method, params }: { id: number; method: string; params: [{ data: Hex }, Hex] }) => {
      if (method !== "eth_call") return { jsonrpc: "2.0", id, error: { code: -32601, message: `unexpected ${method}` } };
      if (failing) return { jsonrpc: "2.0", id, error: { code: -32000, message: "missing trie node" } };
      const block = Number(params[1]);
      blocks.push(block);
      const results = aggregate3Calls(params[0].data).map(({ target, callData }) => {
        if (target.toLowerCase() !== tether) return { success: true, returnData: "0x" as Hex };
        const { functionName } = decodeFunctionData({ abi: erc20Abi, data: callData });
        const returnData =
          functionName === "totalSupply"
            ? encodeFunctionResult({ abi: erc20Abi, functionName: "totalSupply", result: supplyAt(block) })
            : encodeFunctionResult({ abi: erc20Abi, functionName: "decimals", result: 6 });
        return { success: true, returnData };
      });
      return { jsonrpc: "2.0", id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }) };
    };
    const request = JSON.parse(body);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(request) ? request.map(answer) : answer(request)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, blocks };
}

const env = (portalUrl: string, rpcUrl: string, overrides: Partial<SupplyEnv> = {}): SupplyEnv => ({
  PORTAL_URL: portalUrl,
  EVM_RPC_URL: rpcUrl,
  RPC_BATCH_SIZE: 10,
  RPC_MAX_CONCURRENCY: 2,
  START_DATE: "2026-11-05",
  ...overrides,
});

async function drain(batches: AsyncIterable<Batch<SupplyCall>>) {
  const all: Batch<SupplyCall> = { records: [], failed: [] };
  for await (const { records, failed } of batches) {
    all.records.push(...records);
    all.failed.push(...failed);
  }
  return all;
}

const run = (e: SupplyEnv, retry: SupplyCall[] = []) => drain(forChain("ethereum").extract(e, retry));

test("each midnight the head has passed gets each token's supply and decimals at B - 1", async (t) => {
  const [p, r] = [await portal(t), await rpc(t)];
  const { records, failed } = await run(env(p.url, r.url));

  assert.deepEqual(failed, []);
  assert.deepEqual(records, [
    {
      id: `100:${tether}`,
      callId: `2026-11-05T00:00:00.000Z:${tether}`,
      data: { block_number: 100, midnight: "2026-11-05T00:00:00.000Z", token: tether, total_supply: "1000000000100", decimals: 6 },
    },
    {
      id: `103:${tether}`,
      callId: `2026-11-06T00:00:00.000Z:${tether}`,
      data: { block_number: 103, midnight: "2026-11-06T00:00:00.000Z", token: tether, total_supply: "1000000000103", decimals: 6 },
    },
  ]);
  assert.deepEqual(p.asked.sort(), ["2026-11-05T00:00:00.000Z", "2026-11-06T00:00:00.000Z"], "2026-11-07, past the head, is never asked for");
  assert.deepEqual(r.blocks.sort(), [100, 103], "one Multicall3 eth_call per midnight, at B - 1");
});

test("the reads land at B - 1 by Portal's headers, however far off the timestamps route is", async (t) => {
  const r = await rpc(t);
  for (const guess of [(b: number) => b + 3, (b: number) => b - 4, () => 0]) {
    const p = await portal(t, guess);
    const { records } = await run(env(p.url, r.url));
    assert.deepEqual(records.map((r) => r.data.block_number), [100, 103]);
  }
});

test("a token with no code at B - 1 gets null supply and decimals, not a failed call", async (t) => {
  const [p, r] = [await portal(t), await rpc(t)];
  const calls = supplyCallsAt(["2026-11-06T00:00:00.000Z"], [unborn]);
  const { records, failed } = await drain(readSupply(portalClient(p.url), createEvmClient(r.url, { retryCount: 0 }), 105, calls));
  assert.deepEqual(failed, []);
  assert.deepEqual(records.map((r) => r.data), [
    { block_number: 103, midnight: "2026-11-06T00:00:00.000Z", token: unborn, total_supply: null, decimals: null },
  ]);
});

test("a call whose RPC read fails becomes a dead letter keyed by its midnight and token, and its retry succeeds", async (t) => {
  const p = await portal(t);
  const failing = await rpc(t, true);
  const calls = supplyCallsAt(["2026-11-06T00:00:00.000Z"], [tether]);
  const first = await drain(readSupply(portalClient(p.url), createEvmClient(failing.url, { retryCount: 0 }), 105, calls));

  const id = `2026-11-06T00:00:00.000Z:${tether}`;
  assert.deepEqual(first.records, []);
  assert.deepEqual(first.failed.map(({ id, call }) => ({ id, call })), [
    { id, call: { kind: "erc20_supply", midnight: "2026-11-06T00:00:00.000Z", token: tether } },
  ]);

  const healthy = await rpc(t);
  const retry = [supplyCallSchema.parse(first.failed[0]!.call)];
  const again = await run(env(p.url, healthy.url, { END_DATE: "2026-11-05" }), retry);
  assert.deepEqual(again.failed, []);
  assert.deepEqual(
    again.records.map((r) => [r.id, r.callId]),
    [
      [`100:${tether}`, `2026-11-05T00:00:00.000Z:${tether}`],
      [`103:${tether}`, id],
    ],
    "the retried call loads, though END_DATE alone would leave its midnight out",
  );
});

test("a rerun writes the same ids and the same records", async (t) => {
  const [p, r] = [await portal(t), await rpc(t)];
  const first = await run(env(p.url, r.url));
  assert.deepEqual(await run(env(p.url, r.url)), first);
});

/** Runs the rest of the test from a folder whose chains/ethereum/addresses.json holds `json`, as a source runs from its package. */
async function addressesHold(t: TestContext, json: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "evm-erc20-supply-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await mkdir(join(dir, "chains", "ethereum"), { recursive: true });
  await writeFile(join(dir, "chains", "ethereum", "addresses.json"), JSON.stringify(json));
  process.chdir(dir);
}

const firstBatch = () =>
  forChain("ethereum").extract(env("http://127.0.0.1:1", "http://127.0.0.1:2"), [])[Symbol.asyncIterator]().next();

test("a bad address in addresses.json fails the run", async (t) => {
  await addressesHold(t, { tokens: ["0xnot-an-address"] });
  await assert.rejects(firstBatch(), { message: "Invalid Ethereum addresses:\n  0xnot-an-address" });
});

test("addresses.json without tokens fails the run", async (t) => {
  await addressesHold(t, { wallets: [tether] });
  await assert.rejects(firstBatch(), /lists no tokens/);
});

test("each chain loads into a table of its own", () => {
  const source = forChain("ethereum");
  assert.equal(source.name, "ethereum", "runSource writes to raw.ethereum_erc20_supply");
  assert.equal(source.table, "erc20_supply");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
});

test("boundary.ts is the same file as evm-block-headers' copy, until lib holds it", async () => {
  const [mine, theirs] = await Promise.all([readFile("src/boundary.ts", "utf8"), readFile("../evm-block-headers/src/boundary.ts", "utf8")]);
  assert.equal(mine, theirs, "both sources must find the same B for a midnight");
});
