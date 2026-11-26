import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import { erc20Abi, type Hex } from "viem";
import arbitrum from "../chains/arbitrum/addresses.json" with { type: "json" };
import { forChain } from "#src/source.ts";

const [receiving, hop] = arbitrum.wallets.map((a) => a.toLowerCase() as Hex);
const [usdc] = arbitrum.tokens.map((a) => a.toLowerCase() as Hex);
const stranger = "0x00000000000000000000000000000000000000aa";
// Shares the receiving wallet's first and last characters, as the dust senders in ticket #96 did.
const lookalike = `${receiving!.slice(0, 6)}${"0".repeat(32)}${receiving!.slice(-4)}` as Hex;
const otherToken = "0x00000000000000000000000000000000000000bb";

const transfer = (token: Hex, from: Hex, to: Hex, value: bigint) =>
  encodeEvent({ abi: erc20Abi, eventName: "Transfer", address: token, args: { from, to, value } });

/** A local Portal whose blocks hold one of these transfers each, from block 1. */
async function portal(t: TestContext, logs: ReturnType<typeof transfer>[]) {
  const blocks = logs.map((log, i) => mockBlock({ number: i + 1, transactions: [{ logs: [log] }] }));
  const mock = await mockPortal({ blocks });
  t.after(() => mock.close());
  return mock.url;
}

const logs = [
  transfer(usdc!, stranger, receiving!, 2n ** 70n), // into a wallet, past what a JSON number holds
  transfer(usdc!, hop!, stranger, 0n), // out of a wallet, with value 0
  transfer(usdc!, hop!, receiving!, 3n), // between two wallets: in both outputs
  transfer(usdc!, stranger, lookalike, 4n), // to a lookalike of a wallet
  transfer(otherToken, stranger, receiving!, 5n), // a token not in addresses.json
];

async function records(chain: string, url: string, startBlock: number, endBlock?: number) {
  const stream = await forChain(chain).stream({ PORTAL_URL: url, START_BLOCK: startBlock, END_BLOCK: endBlock });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.map(({ id, data }) => ({ id, block: data.block_number, from: data.from, to: data.to, value: data.value }));
}

test("only transfers of listed tokens into or out of listed wallets become records", async (t) => {
  const read = await records("arbitrum", await portal(t, logs), 1);

  assert.deepEqual(
    read.map((r) => r.block).sort(),
    [1, 2, 3, 3],
    "block 3 comes once as incoming and once as outgoing; the lookalike and the other token are left out",
  );
  const [between, again] = read.filter((r) => r.block === 3);
  assert.equal(between!.id, again!.id, "both copies share an id, so the warehouse keeps one row");
  const { id, ...incoming } = read.find((r) => r.block === 1)!;
  assert.match(id, /^1:\d+$/, "a record's id is its block and log index");
  assert.deepEqual(incoming, { block: 1, from: stranger, to: receiving, value: 2n ** 70n });
  assert.equal(read.find((r) => r.block === 2)!.value, 0n, "a zero-value transfer is a record too");
});

test("the stream reads from START_BLOCK to END_BLOCK", async (t) => {
  const read = await records("arbitrum", await portal(t, logs), 2, 2);
  assert.deepEqual(read.map((r) => r.block), [2]);
});

test("addresses.json must list wallets", async (t) => {
  const url = await portal(t, logs);
  const dir = await mkdtemp(path.join(tmpdir(), "wallet-transfers-"));
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  process.chdir(dir);
  await mkdir("chains/testchain", { recursive: true });
  for (const addresses of [{ tokens: [usdc] }, { tokens: [usdc], wallets: [] }]) {
    await writeFile("chains/testchain/addresses.json", JSON.stringify(addresses));
    await assert.rejects(records("testchain", url, 1), /must list wallets/);
  }
});

test("each chain loads into a wallet transfers table of its own", () => {
  assert.equal(forChain("arbitrum").name, "arbitrum", "runSource writes to raw.arbitrum_erc20_wallet_transfers");
  assert.equal(forChain("arbitrum").table, "erc20_wallet_transfers");
  assert.deepEqual(forChain("arbitrum").coverage?.unrestricted, [], "a missing wallets key never means every wallet");
  assert.throws(() => forChain("Arbitrum One"), /chain name/);
});
