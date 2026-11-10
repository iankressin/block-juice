import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
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

const filled = (address: Hex, tokenId = 7n) =>
  log("OrderFilled", address, {
    orderHash,
    maker,
    taker: address,
    side: 1,
    tokenId,
    makerAmountFilled: 5_000_000n,
    takerAmountFilled: 2_000_000n,
    fee: 100n,
    builder,
    metadata,
  });

async function records(t: TestContext, logs: ReturnType<typeof log>[], env: { START_BLOCK?: number; END_BLOCK?: number } = {}) {
  const mock = await mockPortal({ blocks: logs.map((l, i) => mockBlock({ number: i + 1, transactions: [{ logs: [l] }] })) });
  t.after(() => mock.close());
  const stream = await source.stream({ PORTAL_URL: mock.url, START_BLOCK: 1, ...env });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.sort((a, b) => Number(a.data.block_number) - Number(b.data.block_number));
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

test("an empty exchanges list fails the run", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "polygon-polymarket-ctf-exchange-v2-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), JSON.stringify({ exchanges: [] }));
  process.chdir(dir);
  await assert.rejects(records(t, [filled(exchange)]), /exchanges/);
});

test("every exchange and adapter in addresses.json has a row in the polymarket_contracts seed", () => {
  const seeded = readFileSync(new URL("../../../../transformation/seeds/polymarket_contracts.csv", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split(",")[0]);
  for (const address of addresses.exchanges) assert.ok(seeded.includes(address), `${address} is in addresses.json but not in transformation/seeds/polymarket_contracts.csv`);
});
