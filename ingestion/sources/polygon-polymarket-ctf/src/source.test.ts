import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import autoRedeemerAbi from "../../../../catalog/protocols/polymarket/abis/auto-redeemer.json" with { type: "json" };
import collateralAdapterAbi from "../../../../catalog/protocols/polymarket/abis/collateral-adapter.json" with { type: "json" };
import conditionalTokensAbi from "../../../../catalog/protocols/polymarket/abis/conditional-tokens.json" with { type: "json" };
import negRiskAdapterAbi from "../../../../catalog/protocols/polymarket/abis/neg-risk-adapter.json" with { type: "json" };
import addresses from "../addresses.json" with { type: "json" };
import { polygonPolymarketCtf as source } from "#src/source.ts";

const ctf = addresses.conditional_tokens as Hex;
const negRisk = addresses.neg_risk_adapter as Hex;
const [adapter, negRiskAdapter] = addresses.collateral_adapters as [Hex, Hex];
const [autoRedeem, redeemer] = addresses.auto_redeemers as [Hex, Hex];
const stranger = "0x00000000000000000000000000000000000000bb" as Hex;
const user = "0x00000000000000000000000000000000000000aa" as Hex;
const token = "0x00000000000000000000000000000000000000cc" as Hex;
const condition = `0x${"11".repeat(32)}` as Hex;
const question = `0x${"22".repeat(32)}` as Hex;
const market = `0x${"33".repeat(32)}` as Hex;
const zero = `0x${"00".repeat(32)}` as Hex;

// The catalog ABIs are JSON, so viem cannot type an event's args.
const log = (abi: unknown, eventName: string, address: Hex, args: Record<string, unknown>) =>
  encodeEvent({ abi: abi as Abi, eventName, address, args: args as never });

async function records(t: TestContext, logs: ReturnType<typeof log>[], env: { START_BLOCK?: number; END_BLOCK?: number } = {}) {
  const mock = await mockPortal({ blocks: logs.map((l, i) => mockBlock({ number: i + 1, transactions: [{ logs: [l] }] })) });
  t.after(() => mock.close());
  const stream = await source.stream({ PORTAL_URL: mock.url, START_BLOCK: 1, ...env });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.sort((a, b) => Number(a.data.block_number) - Number(b.data.block_number));
}

const listed = [
  log(conditionalTokensAbi, "ConditionPreparation", ctf, { conditionId: condition, oracle: user, questionId: question, outcomeSlotCount: 2n }),
  log(conditionalTokensAbi, "ConditionResolution", ctf, { conditionId: condition, oracle: user, questionId: question, outcomeSlotCount: 2n, payoutNumerators: [1n, 0n] }),
  log(conditionalTokensAbi, "PositionSplit", ctf, { stakeholder: user, collateralToken: token, parentCollectionId: zero, conditionId: condition, partition: [1n, 2n], amount: 5n }),
  log(conditionalTokensAbi, "PositionsMerge", ctf, { stakeholder: user, collateralToken: token, parentCollectionId: zero, conditionId: condition, partition: [1n, 2n], amount: 6n }),
  log(conditionalTokensAbi, "PayoutRedemption", ctf, { redeemer: user, collateralToken: token, parentCollectionId: zero, conditionId: condition, indexSets: [1n, 2n], payout: 7n }),
  log(negRiskAdapterAbi, "MarketPrepared", negRisk, { marketId: market, oracle: user, feeBips: 100n, data: "0x1234" }),
  log(negRiskAdapterAbi, "QuestionPrepared", negRisk, { marketId: market, questionId: question, index: 3n, data: "0x" }),
  log(negRiskAdapterAbi, "OutcomeReported", negRisk, { marketId: market, questionId: question, outcome: true }),
  log(negRiskAdapterAbi, "PositionSplit", negRisk, { stakeholder: user, conditionId: condition, amount: 8n }),
  log(negRiskAdapterAbi, "PositionsMerge", negRisk, { stakeholder: user, conditionId: condition, amount: 9n }),
  log(negRiskAdapterAbi, "PositionsConverted", negRisk, { stakeholder: user, marketId: market, indexSet: 3n, amount: 10n }),
  log(negRiskAdapterAbi, "PayoutRedemption", negRisk, { redeemer: user, conditionId: condition, amounts: [11n, 12n], payout: 13n }),
  log(collateralAdapterAbi, "PositionSplit", adapter, { initiator: user, conditionId: condition, amount: 14n }),
  log(collateralAdapterAbi, "PositionsMerged", adapter, { initiator: user, conditionId: condition, amount: 15n }),
  log(collateralAdapterAbi, "PositionsRedeemed", negRiskAdapter, { initiator: user, conditionId: condition, amounts: [16n, 17n], payout: 18n }),
  log(collateralAdapterAbi, "PositionsConverted", negRiskAdapter, { initiator: user, marketId: market, indexSet: 3n, amount: 19n, amountOut: 20n }),
  log(autoRedeemerAbi, "BinaryRedemption", autoRedeem, { from: user, conditionId: condition, payout: 21n }),
  log(autoRedeemerAbi, "NegRiskRedemption", redeemer, { from: user, conditionId: condition, payout: 22n }),
];

test("each listed event becomes a record with its decoded args", async (t) => {
  const read = await records(t, listed);
  assert.deepEqual(
    read.map((r) => [r.data.event, r.data.contract]),
    [
      ["ctf.ConditionPreparation", ctf],
      ["ctf.ConditionResolution", ctf],
      ["ctf.PositionSplit", ctf],
      ["ctf.PositionsMerge", ctf],
      ["ctf.PayoutRedemption", ctf],
      ["neg_risk.MarketPrepared", negRisk],
      ["neg_risk.QuestionPrepared", negRisk],
      ["neg_risk.OutcomeReported", negRisk],
      ["neg_risk.PositionSplit", negRisk],
      ["neg_risk.PositionsMerge", negRisk],
      ["neg_risk.PositionsConverted", negRisk],
      ["neg_risk.PayoutRedemption", negRisk],
      ["collateral_adapter.PositionSplit", adapter],
      ["collateral_adapter.PositionsMerged", adapter],
      ["collateral_adapter.PositionsRedeemed", negRiskAdapter],
      ["collateral_adapter.PositionsConverted", negRiskAdapter],
      ["auto_redeemer.BinaryRedemption", autoRedeem],
      ["auto_redeemer.NegRiskRedemption", redeemer],
    ],
  );
  const byEvent = Object.fromEntries(read.map((r) => [r.data.event, r]));
  assert.match(read[0]!.id, /^1:\d+$/, "a record's id is its block and log index");
  assert.equal(read[0]!.data.kind, "log");
  assert.deepEqual(byEvent["ctf.PositionSplit"]!.data.args, {
    stakeholder: user,
    collateralToken: token,
    parentCollectionId: zero,
    conditionId: condition,
    partition: [1n, 2n],
    amount: 5n,
  });
  assert.deepEqual(byEvent["neg_risk.PositionsConverted"]!.data.args, { stakeholder: user, marketId: market, indexSet: 3n, amount: 10n });
  assert.deepEqual(byEvent["collateral_adapter.PositionsConverted"]!.data.args, {
    initiator: user,
    marketId: market,
    indexSet: 3n,
    amount: 19n,
    amountOut: 20n,
  });
  assert.deepEqual(byEvent["auto_redeemer.NegRiskRedemption"]!.data.args, { from: user, conditionId: condition, payout: 22n });
});

test("the same events from another contract are left out", async (t) => {
  const read = await records(t, [
    log(conditionalTokensAbi, "PositionSplit", stranger, { stakeholder: user, collateralToken: token, parentCollectionId: zero, conditionId: condition, partition: [1n, 2n], amount: 1n }),
    // The collateral adapter's PositionSplit has the neg-risk adapter's topic0: only the address tells them apart.
    log(collateralAdapterAbi, "PositionSplit", stranger, { initiator: user, conditionId: condition, amount: 2n }),
    log(negRiskAdapterAbi, "PositionSplit", stranger, { stakeholder: user, conditionId: condition, amount: 3n }),
    log(autoRedeemerAbi, "BinaryRedemption", stranger, { from: user, conditionId: condition, payout: 4n }),
    // A listed contract's event that the source does not load.
    log(conditionalTokensAbi, "TransferSingle", ctf, { operator: user, from: user, to: stranger, id: 1n, value: 5n }),
    log(collateralAdapterAbi, "PositionSplit", negRiskAdapter, { initiator: user, conditionId: condition, amount: 6n }),
  ]);
  assert.deepEqual(
    read.map((r) => [r.data.block_number, r.data.event, r.data.contract]),
    [[6, "collateral_adapter.PositionSplit", negRiskAdapter]],
    "a PositionSplit from an adapter is named for the adapter, never for the neg-risk adapter",
  );
});

test("the same topic from the neg-risk adapter is named for the neg-risk adapter", async (t) => {
  const read = await records(t, [
    log(negRiskAdapterAbi, "PositionSplit", negRisk, { stakeholder: user, conditionId: condition, amount: 3n }),
    log(collateralAdapterAbi, "PositionSplit", adapter, { initiator: user, conditionId: condition, amount: 4n }),
  ]);
  assert.deepEqual(
    read.map((r) => [r.data.event, r.data.args]),
    [
      ["neg_risk.PositionSplit", { stakeholder: user, conditionId: condition, amount: 3n }],
      ["collateral_adapter.PositionSplit", { initiator: user, conditionId: condition, amount: 4n }],
    ],
  );
});

test("the stream starts at START_BLOCK and stops at END_BLOCK", async (t) => {
  const split = (amount: bigint) =>
    log(conditionalTokensAbi, "PositionSplit", ctf, { stakeholder: user, collateralToken: token, parentCollectionId: zero, conditionId: condition, partition: [1n, 2n], amount });
  const read = await records(t, [split(1n), split(2n), split(3n), split(4n)], { START_BLOCK: 2, END_BLOCK: 3 });
  assert.deepEqual(read.map((r) => r.data.block_number), [2, 3]);
});

for (const key of ["conditional_tokens", "neg_risk_adapter", "collateral_adapters", "auto_redeemers"] as const) {
  test(`an addresses.json without ${key} fails the run`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "polygon-polymarket-ctf-"));
    const cwd = process.cwd();
    t.after(async () => {
      process.chdir(cwd);
      await rm(dir, { recursive: true });
    });
    const { [key]: _removed, ...rest } = addresses;
    await writeFile(join(dir, "addresses.json"), JSON.stringify(rest));
    process.chdir(dir);
    await assert.rejects(records(t, listed), new RegExp(key));
  });
}
