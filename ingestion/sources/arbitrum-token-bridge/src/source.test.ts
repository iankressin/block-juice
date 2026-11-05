import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal } from "@subsquid/pipes/testing";
import { encodeEvent, mockBlock } from "@subsquid/pipes/testing/evm";
import type { Abi, Hex } from "viem";
import gatewayAbi from "../../../../catalog/protocols/arbitrum-token-bridge/abis/l2-custom-gateway.json" with { type: "json" };
import addresses from "../addresses.json" with { type: "json" };
import { GATEWAY, source } from "#src/source.ts";

const abi = gatewayAbi as Abi;
const sqd = addresses.tokens[0]!.toLowerCase() as Hex;
const other = "0x00000000000000000000000000000000000000bb";
const user = "0x00000000000000000000000000000000000000aa";
const l1 = "0x00000000000000000000000000000000000000cc";
const elsewhere = "0x00000000000000000000000000000000000000dd";

const deposit = (address: Hex, l1Token: Hex, amount: bigint) =>
  encodeEvent({ abi, eventName: "DepositFinalized", address, args: { l1Token, _from: l1, _to: user, _amount: amount } as never });
const withdrawal = (l1Token: Hex, amount: bigint) =>
  encodeEvent({
    abi,
    eventName: "WithdrawalInitiated",
    address: GATEWAY,
    // The catalog ABI is JSON, so viem cannot type an event's args.
    args: { l1Token, _from: user, _to: l1, _l2ToL1Id: 7n, _exitNum: 1n, _amount: amount } as never,
  });

async function records(t: TestContext) {
  const logs = [
    deposit(GATEWAY, sqd, 1n), // kept
    deposit(GATEWAY, other, 2n), // another token's deposit: the query filters it out
    withdrawal(other, 3n), // kept: the token of a withdrawal is not indexed, so dbt filters it
    withdrawal(sqd, 4n), // kept
    deposit(elsewhere, sqd, 5n), // another contract
  ];
  const mock = await mockPortal({ blocks: logs.map((log, i) => mockBlock({ number: i + 1, transactions: [{ logs: [log] }] })) });
  t.after(() => mock.close());
  const stream = await source.stream({ PORTAL_URL: mock.url, START_BLOCK: 1 });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return read.sort((a, b) => Number(a.data.block_number) - Number(b.data.block_number));
}

test("deposits of the listed tokens and every withdrawal become records, each log as emitted", async (t) => {
  const read = await records(t);
  assert.deepEqual(read.map((r) => [r.data.block_number, r.data.event]), [
    [1, "DepositFinalized"],
    [3, "WithdrawalInitiated"],
    [4, "WithdrawalInitiated"],
  ]);
  const [first] = read;
  assert.match(first!.id, /^1:\d+$/, "a record's id is its block and log index");
  assert.deepEqual(first!.data.args, { l1Token: sqd, _from: l1, _to: user, _amount: 1n });
});
