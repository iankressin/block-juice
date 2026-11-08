import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import { getAddress, zeroAddress, type Abi, type Hex } from "viem";
import tetherAbi from "../../../../catalog/protocols/tether-token/abis/tether-token-ethereum.json" with { type: "json" };
import addresses from "../chains/ethereum/addresses.json" with { type: "json" };
import { forChain, type TetherTokenEnv } from "#src/source.ts";

const source = forChain("ethereum");
const tether = addresses.tokens[0]!.toLowerCase() as Hex;
const otherToken = "0x00000000000000000000000000000000000000bb";
const address = (n: string) => getAddress(`0x${n.padStart(40, "0")}`);
const [alice, bob, banned] = [address("a11ce"), address("b0b"), address("bad")];

const event = (eventName: string, args: Record<string, unknown> = {}, address: Hex = tether) =>
  encodeEvent({ abi: tetherAbi as Abi, eventName, address, args } as Parameters<typeof encodeEvent>[0]);

// Block 102 has no logs at all: it still loads, as a block record.
const blocks = [
  mockBlock({
    number: 101,
    timestamp: 1794009599,
    transactions: [
      { from: alice, to: tether, logs: [event("Transfer", { from: alice, to: bob, value: 2n ** 70n }), event("Approval", { owner: alice, spender: bob, value: 1n })] },
      { from: bob, logs: [event("Transfer", { from: bob, to: alice, value: 3n }, otherToken)] },
    ],
  }),
  mockBlock({
    number: 103,
    timestamp: 1794009623,
    transactions: [
      { from: bob, to: tether, logs: [event("Issue", { amount: 10n ** 12n })] },
      { from: bob, to: tether, logs: [event("DestroyedBlackFunds", { _blackListedUser: banned, _balance: 7n }), event("Transfer", { from: alice, to: zeroAddress, value: 5n })] },
    ],
  }),
  mockBlock({ number: 104, timestamp: 1794009635, transactions: [{ from: bob, to: tether, logs: [event("Pause")] }] }),
];

async function portal(t: TestContext) {
  const mock = await mockPortal({ blocks });
  t.after(() => mock.close());
  return mock.url;
}

type Loaded = Record<string, unknown> & { id: string; kind: string; args?: Record<string, unknown> };

async function records(env: TetherTokenEnv): Promise<Loaded[]> {
  const stream = await source.stream(env);
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  for (const r of read) assert.equal(r.callId, r.id, "a stream record answers no call");
  return read.map(({ id, data }) => ({ id, ...data }) as Loaded);
}

const at = (url: string, overrides: Partial<TetherTokenEnv> = {}): TetherTokenEnv => ({ PORTAL_URL: url, START_BLOCK: 101, ...overrides });

test("every block from START_BLOCK to END_BLOCK becomes a block record, with logs or without", async (t) => {
  const read = await records(at(await portal(t), { END_BLOCK: 103 }));
  assert.deepEqual(
    read.filter((r) => r.kind === "block"),
    [
      { id: "block:101", kind: "block", block_number: 101, block_hash: blocks[0]!.header.hash, timestamp: "2026-11-06T23:59:59.000Z" },
      { id: "block:102", kind: "block", block_number: 102, block_hash: `0x${(102).toString(16).padStart(64, "0")}`, timestamp: "1970-01-02T04:20:00.000Z" },
      { id: "block:103", kind: "block", block_number: 103, block_hash: blocks[1]!.header.hash, timestamp: "2026-11-07T00:00:23.000Z" },
    ],
    "nothing past END_BLOCK",
  );
});

test("only the listed events of the listed tokens become logs: no Approval, no other contract's Transfer", async (t) => {
  const read = await records(at(await portal(t)));
  assert.deepEqual(
    read.filter((r) => r.kind === "log").map((r) => `${r.id} ${r.event}`),
    ["101:0 Transfer", "103:0 Issue", "103:1 DestroyedBlackFunds", "103:2 Transfer", "104:0 Pause"],
  );
});

test("a log record is the log as emitted, keyed by its place in the chain, its integers as decimal strings", async (t) => {
  const read = await records(at(await portal(t)));
  const transfer = read.find((r) => r.id === "101:0")!;
  assert.deepEqual(transfer, {
    id: "101:0",
    kind: "log",
    event: "Transfer",
    block_number: 101,
    block_hash: blocks[0]!.header.hash,
    timestamp: "2026-11-06T23:59:59.000Z",
    tx_hash: blocks[0]!.transactions[0]!.hash,
    tx_index: 0,
    log_index: 0,
    contract: tether,
    args: { from: alice, to: bob, value: (2n ** 70n).toString() },
  });
});

test("Issue, DestroyedBlackFunds and Pause decode with their arguments by name", async (t) => {
  const read = await records(at(await portal(t)));
  const args = (id: string) => read.find((r) => r.id === id)!.args;
  assert.deepEqual(args("103:0"), { amount: "1000000000000" });
  assert.deepEqual(args("103:1"), { _blackListedUser: banned, _balance: "7" });
  assert.deepEqual(args("104:0"), {});
});

test("a Transfer to the zero address is stored as a plain Transfer log", async (t) => {
  const read = await records(at(await portal(t)));
  const burn = read.find((r) => r.id === "103:2")!;
  assert.equal(burn.event, "Transfer");
  assert.deepEqual(burn.args, { from: alice, to: zeroAddress, value: "5" });
});

test("each written log's transaction becomes a record of its own, and no other transaction does", async (t) => {
  const read = await records(at(await portal(t)));
  const [approvalTx, otherTokenTx] = [blocks[0]!.transactions[0]!, blocks[0]!.transactions[1]!];
  const transactions = read.filter((r) => r.kind === "transaction");
  assert.deepEqual(
    transactions.map((r) => r.id).sort(),
    [approvalTx.hash, ...blocks[1]!.transactions.map((tx) => tx.hash), blocks[2]!.transactions[0]!.hash].map((h) => `tx:${h}`).sort(),
    "none for the other token's Transfer",
  );
  assert.equal(transactions.some((r) => r.id === `tx:${otherTokenTx.hash}`), false);
  assert.deepEqual(read.find((r) => r.id === `tx:${approvalTx.hash}`), {
    id: `tx:${approvalTx.hash}`,
    kind: "transaction",
    block_number: 101,
    tx_index: 0,
    hash: approvalTx.hash,
    from: alice.toLowerCase(),
    to: tether,
  });
});

test("a rerun over the same blocks writes the same ids and the same records", async (t) => {
  const url = await portal(t);
  const first = await records(at(url));
  const again = await records(at(url));
  assert.deepEqual(again, first);
  assert.equal(new Set(first.map((r) => r.id)).size, first.length, "no id repeats within a run");
});

/** Runs the rest of the test from a folder whose chains/ethereum/addresses.json holds `json`, as a source runs from its package. */
async function addressesHold(t: TestContext, json: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "evm-tether-token-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await mkdir(join(dir, "chains", "ethereum"), { recursive: true });
  await writeFile(join(dir, "chains", "ethereum", "addresses.json"), JSON.stringify(json));
  process.chdir(dir);
}

const unreachable = at("http://127.0.0.1:1");

test("wallets in addresses.json fail the run: the history is contract-wide", async (t) => {
  await addressesHold(t, { tokens: [tether], wallets: [alice] });
  await assert.rejects(source.stream(unreachable), /lists wallets, but this source loads every log of its tokens/);
});

test("a bad address in addresses.json fails the run", async (t) => {
  await addressesHold(t, { tokens: ["0xnot-an-address"] });
  await assert.rejects(source.stream(unreachable), { message: "Invalid Ethereum addresses:\n  0xnot-an-address" });
});

test("addresses.json without tokens fails the run", async (t) => {
  await addressesHold(t, { tokens: [] });
  await assert.rejects(source.stream(unreachable), /lists no tokens/);
});

test("each chain loads into a table of its own, and END_BLOCK cannot come before START_BLOCK", () => {
  assert.equal(source.name, "ethereum", "runSource writes to raw.ethereum_tether_token");
  assert.equal(source.table, "tether_token");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
  const parsed = source.env.safeParse({ PORTAL_URL: "http://127.0.0.1:1", START_BLOCK: "103", END_BLOCK: "102" });
  assert.match(parsed.error!.message, /END_BLOCK must not be before START_BLOCK/);
});
