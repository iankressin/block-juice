import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { mockBlock } from "@subsquid/pipes/testing/evm";
import type { Hex } from "viem";
import ethereum from "../chains/ethereum/addresses.json" with { type: "json" };
import { forChain } from "#src/source.ts";

// addresses.json lists the wallets as published, in mixed case; Portal returns lowercase.
const [wallet, other] = ethereum.wallets.map((a) => a.toLowerCase() as Hex);
const stranger = "0x00000000000000000000000000000000000000aa";
const otherStranger = "0x00000000000000000000000000000000000000cc";

type Tx = { from: Hex; to?: Hex; value: bigint; status?: number };

const hex = (n: bigint | number) => `0x${n.toString(16)}`;

/** A local Portal whose blocks hold one of these transactions each, from block 1, with receipt fields. */
async function portal(t: TestContext, txs: Tx[]) {
  const blocks = txs.map((tx, i) => {
    const block = mockBlock({ number: i + 1, transactions: [{ from: tx.from, to: tx.to, logs: [] }] });
    block.transactions = block.transactions.map((base) => ({
      ...base,
      nonce: 0,
      value: hex(tx.value),
      type: 2,
      status: tx.status ?? 1,
      gasUsed: hex(21000),
      gasPrice: hex(3_000_000_000),
      effectiveGasPrice: hex(3_000_000_000),
    })) as typeof block.transactions;
    return block;
  });
  const mock = await mockPortal({ blocks });
  t.after(() => mock.close());
  return mock.url;
}

async function records(url: string, startBlock: number, endBlock?: number) {
  const stream = await forChain("ethereum").stream({ PORTAL_URL: url, START_BLOCK: startBlock, END_BLOCK: endBlock });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.map(({ id, data }) => ({ id, ...data }));
}

const txs: Tx[] = [
  { from: wallet!, to: stranger, value: 1n }, // sent by a wallet
  { from: stranger, to: other!, value: 2n ** 70n }, // into a wallet, past what a JSON number holds
  { from: wallet!, to: other!, value: 3n, status: 0 }, // between two wallets, and failed
  { from: stranger, to: otherStranger, value: 4n }, // touches no wallet
  { from: other!, value: 5n }, // a wallet's contract creation: no `to`
];

test("only transactions from or to listed wallets become records, once each", async (t) => {
  const read = await records(await portal(t, txs), 1);

  assert.deepEqual(read.map((r) => r.block_number), [1, 2, 3, 5], "block 3 comes once; block 4 is left out");
  const incoming = read.find((r) => r.block_number === 2)!;
  assert.match(incoming.id, /^tx:0x[0-9a-f]{64}$/, "a record's id is its transaction hash");
  assert.equal(incoming.kind, "transaction");
  assert.equal(incoming.from, stranger);
  assert.equal(incoming.to, other);
  assert.equal(incoming.value, 2n ** 70n);
  assert.equal(incoming.gas_used, 21000n);
  assert.equal(incoming.effective_gas_price, 3_000_000_000n);
  assert.equal(read.find((r) => r.block_number === 3)!.status, 0, "a failed transaction stays, with its status");
  assert.equal(read.find((r) => r.block_number === 5)!.to, null);
});

test("the stream starts at START_BLOCK and stops at END_BLOCK", async (t) => {
  const read = await records(await portal(t, txs), 2, 3);
  assert.deepEqual(read.map((r) => r.block_number), [2, 3]);
});

test("each chain loads into a table of its own", () => {
  assert.equal(forChain("ethereum").name, "ethereum", "runSource writes to raw.ethereum_wallet_transactions");
  assert.equal(forChain("ethereum").table, "wallet_transactions");
  assert.throws(() => forChain("Ethereum Mainnet"), /chain name/);
});
