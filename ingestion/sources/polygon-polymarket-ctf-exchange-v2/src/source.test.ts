import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { defineAbi, type JsonAbiItem } from "@subsquid/pipes/evm";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import exchangeAbi from "../../../../catalog/protocols/polymarket/abis/ctf-exchange-v2.json" with { type: "json" };
import addresses from "../addresses.json" with { type: "json" };
import { polygonPolymarketCtfExchangeV2 as source } from "#src/source.ts";

const [exchange, negRiskA, negRiskB] = addresses.exchanges as [Hex, Hex, Hex];
const stranger = "0x00000000000000000000000000000000000000bb" as Hex;
const maker = "0x00000000000000000000000000000000000000aa" as Hex;
const orderHash = `0x${"11".repeat(32)}` as Hex;
const builder = `0x${"22".repeat(32)}` as Hex;
const metadata = `0x${"33".repeat(32)}` as Hex;

// The catalog ABI is JSON, so viem cannot type an event's args.
const log = (eventName: string, address: Hex, args: Record<string, unknown>) =>
  encodeEvent({ abi: exchangeAbi as Abi, eventName, address, args: args as never });

const filled = (address: Hex, tokenId = 7n, orderMaker = maker) =>
  log("OrderFilled", address, {
    orderHash,
    maker: orderMaker,
    taker: address,
    side: 1,
    tokenId,
    makerAmountFilled: 5_000_000n,
    takerAmountFilled: 2_000_000n,
    fee: 100n,
    builder,
    metadata,
  });

type Env = { START_BLOCK?: number; END_BLOCK?: number };

// Every record a run over these blocks writes, logs and transactions, by block.
async function streamed(t: TestContext, blocks: ReturnType<typeof mockBlock>[], env: Env = {}) {
  const mock = await mockPortal({ blocks });
  t.after(() => mock.close());
  const stream = await source.stream({ PORTAL_URL: mock.url, START_BLOCK: 1, ...env });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.sort((a, b) => Number(a.data.block_number) - Number(b.data.block_number));
}

// The log records of a run with one log per block, each in a transaction of its own.
async function records(t: TestContext, logs: ReturnType<typeof log>[], env: Env = {}) {
  const blocks = logs.map((l, i) => callBlock(i + 1, exchange, "0x", [l]));
  return (await streamed(t, blocks, env)).filter((r) => r.data.kind === "log");
}

const matchOrders = defineAbi(exchangeAbi as readonly JsonAbiItem[]).functions.matchOrders!;
const signer = "0x00000000000000000000000000000000000000cc" as Hex;
const conditionId = `0x${"44".repeat(32)}` as Hex;

// One signed order as matchOrders takes it: a buy of token 7 at 0.5.
const order = (orderMaker: Hex, salt: bigint) => ({
  salt,
  maker: orderMaker,
  signer,
  tokenId: 7n,
  makerAmount: 5_000_000n,
  takerAmount: 10_000_000n,
  side: 0,
  signatureType: 1,
  timestamp: 1_786_383_561_160n,
  metadata,
  builder,
  signature: `0x${"ab".repeat(65)}`,
});

const match = {
  conditionId,
  takerOrder: order(stranger, 1n),
  makerOrders: [order(maker, 2n), order(maker, 3n)],
  takerFillAmount: 4_000_000n,
  makerFillAmounts: [2_500_000n, 1_500_000n],
  takerFeeAmount: 40_000n,
  makerFeeAmounts: [0n, 0n],
};

// A block whose one transaction calls `to` with `input` and emits `logs`. mockBlock leaves out a
// transaction's input, so it is set here.
function callBlock(number: number, to: Hex, input: string, logs: ReturnType<typeof log>[]) {
  const block = mockBlock({ number, transactions: [{ from: stranger, to, logs }] });
  Object.assign(block.transactions[0]!, { input });
  return block;
}

async function useAddresses(t: TestContext, listed: object) {
  const dir = await mkdtemp(join(tmpdir(), "polygon-polymarket-ctf-exchange-v2-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), JSON.stringify(listed));
  process.chdir(dir);
}

test("OrderFilled from each listed exchange becomes a record", async (t) => {
  const read = await records(t, [filled(exchange), filled(negRiskA), filled(negRiskB)]);
  assert.deepEqual(
    read.map((r) => [r.data.kind, r.data.event, r.data.contract]),
    [
      ["log", "ctf_exchange_v2.OrderFilled", exchange],
      ["log", "ctf_exchange_v2.OrderFilled", negRiskA],
      ["log", "ctf_exchange_v2.OrderFilled", negRiskB],
    ],
  );
  assert.match(read[0]!.id, /^1:\d+$/, "a record's id is its block and log index");
  assert.equal(read[0]!.callId, read[0]!.id);
  assert.deepEqual(read[0]!.data.args, {
    orderHash,
    maker,
    taker: exchange,
    side: 1,
    tokenId: 7n,
    makerAmountFilled: 5_000_000n,
    takerAmountFilled: 2_000_000n,
    fee: 100n,
    builder,
    metadata,
  });
});

test("OrderFilled from an unlisted contract is left out", async (t) => {
  const read = await records(t, [
    filled(stranger),
    // A listed exchange's event that the source does not load.
    log("OrdersMatched", exchange, { takerOrderHash: orderHash, takerOrderMaker: maker, side: 0, tokenId: 7n, makerAmountFilled: 1n, takerAmountFilled: 2n }),
    log("FeeCharged", exchange, { receiver: maker, amount: 3n }),
    filled(exchange, 9n),
  ]);
  assert.deepEqual(
    read.map((r) => [r.data.block_number, r.data.contract]),
    [[4, exchange]],
  );
});

test("START_BLOCK and END_BLOCK bound the stream", async (t) => {
  const read = await records(t, [filled(exchange, 1n), filled(exchange, 2n), filled(exchange, 3n), filled(exchange, 4n)], { START_BLOCK: 2, END_BLOCK: 3 });
  assert.deepEqual(read.map((r) => r.data.block_number), [2, 3]);
});

test("with wallets listed, only the fills whose maker is listed load", async (t) => {
  await useAddresses(t, { ...addresses, wallets: [maker] });
  const read = await records(t, [filled(exchange, 1n, stranger), filled(exchange, 2n), filled(negRiskA, 3n, stranger)]);
  assert.deepEqual(
    read.map((r) => [r.data.block_number, (r.data.args as { maker: string }).maker]),
    [[2, maker]],
  );
});

test("a fill's transaction becomes a record of its own, with its matchOrders call decoded", async (t) => {
  const read = await streamed(t, [callBlock(1, exchange, matchOrders.encode(match), [filled(exchange)])]);
  const [fill] = read.filter((r) => r.data.kind === "log");
  const transactions = read.filter((r) => r.data.kind === "transaction");
  assert.equal(transactions.length, 1);
  const { id, callId, data } = transactions[0]!;
  assert.equal(id, `tx:${fill!.data.tx_hash}`, "a transaction's id is its hash");
  assert.equal(callId, id);
  assert.deepEqual(data, {
    kind: "transaction",
    block_number: 1,
    timestamp: fill!.data.timestamp,
    hash: fill!.data.tx_hash,
    from: stranger,
    to: exchange,
    function: "matchOrders",
    args: match,
  });
  assert.equal("from" in fill!.data, false, "a log never carries its transaction's fields");
});

test("a transaction that is not a matchOrders call keeps its input as sent", async (t) => {
  const read = await streamed(t, [callBlock(1, stranger, "0xdeadbeef", [filled(exchange)])]);
  const { data } = read.find((r) => r.data.kind === "transaction")!;
  assert.equal(data.function, null);
  assert.equal(data.input, "0xdeadbeef");
  assert.equal("args" in data, false);
});

test("with wallets listed, only the transactions of the fills written load", async (t) => {
  await useAddresses(t, { ...addresses, wallets: [maker] });
  const input = matchOrders.encode(match);
  const read = await streamed(t, [
    callBlock(1, exchange, input, [filled(exchange, 1n, stranger)]),
    callBlock(2, exchange, input, [filled(exchange, 2n)]),
  ]);
  const fills = read.filter((r) => r.data.kind === "log");
  assert.deepEqual(
    read.filter((r) => r.data.kind === "transaction").map((r) => r.id),
    fills.map((r) => `tx:${r.data.tx_hash}`),
  );
  assert.deepEqual(fills.map((r) => r.data.block_number), [2]);
});

test("an empty exchanges list fails the run", async (t) => {
  await useAddresses(t, { exchanges: [] });
  await assert.rejects(records(t, [filled(exchange)]), /exchanges/);
});

test("an empty wallets list fails the run", async (t) => {
  await useAddresses(t, { ...addresses, wallets: [] });
  await assert.rejects(records(t, [filled(exchange)]), /wallets/);
});

test("every exchange and adapter in addresses.json has a row in the polymarket_contracts seed", () => {
  const seeded = readFileSync(new URL("../../../../transformation/seeds/polymarket_contracts.csv", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[0]);
  for (const address of addresses.exchanges) assert.ok(seeded.includes(address), `${address} is in addresses.json but not in transformation/seeds/polymarket_contracts.csv`);
});
