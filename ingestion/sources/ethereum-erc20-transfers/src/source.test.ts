import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import { erc20Abi, type Hex } from "viem";
import addresses from "../addresses.json" with { type: "json" };
import { ethereumErc20Transfers } from "#src/source.ts";

const [binance, coinbase] = addresses.wallets.map((a) => a.toLowerCase() as Hex);
const [usdc] = addresses.tokens.map((a) => a.toLowerCase() as Hex);
const stranger = "0x00000000000000000000000000000000000000aa";
const otherToken = "0x00000000000000000000000000000000000000bb";

const transfer = (token: Hex, from: Hex, to: Hex, value: bigint) =>
  encodeEvent({ abi: erc20Abi, eventName: "Transfer", address: token, args: { from, to, value } });

/** A local Portal whose blocks 1 to 5 hold one transfer each. */
async function portal(t: TestContext) {
  const logs = [
    transfer(usdc!, binance!, stranger, 1n), // out of a wallet
    transfer(usdc!, stranger, coinbase!, 2n ** 70n), // into a wallet, past what a JSON number holds
    transfer(usdc!, binance!, coinbase!, 3n), // between two wallets: in both outputs
    transfer(usdc!, stranger, stranger, 4n), // touches no wallet
    transfer(otherToken, binance!, stranger, 5n), // a token not in addresses.json
  ];
  const blocks = logs.map((log, i) => mockBlock({ number: i + 1, transactions: [{ logs: [log] }] }));
  const mock = await mockPortal({ blocks });
  t.after(() => mock.close());
  return mock.url;
}

async function records(url: string, startBlock: number) {
  const stream = await ethereumErc20Transfers.stream({ PORTAL_URL: url, START_BLOCK: startBlock });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.map(({ id, data }) => ({ id, block: data.block_number, from: data.from, to: data.to, value: data.value }));
}

test("only transfers of listed tokens into or out of listed wallets become records", async (t) => {
  const read = await records(await portal(t), 1);

  assert.deepEqual(
    read.map((r) => r.block).sort(),
    [1, 2, 3, 3],
    "block 3 comes once as incoming and once as outgoing; blocks 4 and 5 are left out",
  );
  const [between, again] = read.filter((r) => r.block === 3);
  assert.equal(between!.id, again!.id, "both copies share an id, so the warehouse keeps one row");
  const { id, ...incoming } = read.find((r) => r.block === 2)!;
  assert.match(id, /^2:\d+$/, "a record's id is its block and log index");
  assert.deepEqual(incoming, { block: 2, from: stranger, to: coinbase, value: 2n ** 70n });
});

test("the stream starts at START_BLOCK", async (t) => {
  const read = await records(await portal(t), 3);
  assert.deepEqual(read.map((r) => r.block), [3, 3]);
});
