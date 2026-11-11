import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, type Hex } from "viem";
import ethereum from "../chains/ethereum/addresses.json" with { type: "json" };
import { blockRecords, CREATE_ORDER, keptEvent, TOPICS, type Filter } from "#src/source.ts";

const lower = (a: string[]) => new Set(a.map((x) => x.toLowerCase()));
const filter: Filter = {
  wallets: lower(ethereum.wallets),
  ethFlow: lower(ethereum.ethFlow),
  settlement: lower(ethereum.settlement),
};
const wallet = ethereum.wallets[0]!.toLowerCase();
const ethFlow = ethereum.ethFlow[0]!.toLowerCase();
const settlement = ethereum.settlement[0]!.toLowerCase();
const token = "0x00000000000000000000000000000000000000dd";
const stranger = "0x00000000000000000000000000000000000000aa";
const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;

const transfer = (to: string, logIndex: number) => ({
  logIndex,
  transactionIndex: 1,
  transactionHash: "0x" + "11".repeat(32),
  address: token,
  topics: [TOPICS.Transfer, pad(settlement), pad(to)],
  data: encodeAbiParameters([{ type: "uint256" }], [2n ** 70n]),
});

const trade = (address: string, logIndex: number) => ({
  logIndex,
  transactionIndex: 1,
  transactionHash: "0x" + "11".repeat(32),
  address,
  topics: [TOPICS.Trade, pad(ethFlow)],
  data: encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    [stranger, token, 10n, 20n, 0n, ("0x" + "ab".repeat(56)) as Hex],
  ),
});

test("keeps Transfers into a wallet and Trades from the settlement, nothing else", () => {
  assert.equal(keptEvent(transfer(wallet, 0), filter), "Transfer");
  assert.equal(keptEvent(transfer(stranger, 0), filter), undefined, "a Transfer to another address");
  assert.equal(keptEvent(trade(settlement, 0), filter), "Trade");
  assert.equal(keptEvent(trade(stranger, 0), filter), undefined, "a Trade-shaped log from a fork");
});

test("decodes logs and keeps createOrder calls from a wallet with their output", () => {
  const records = blockRecords(
    {
      header: { number: 7, hash: "0x" + "00".repeat(32), timestamp: 1_700_000_000 },
      transactions: [{ transactionIndex: 1, hash: "0x" + "11".repeat(32) }],
      logs: [transfer(wallet, 3), trade(settlement, 4), transfer(stranger, 5)],
      traces: [
        {
          type: "call",
          transactionIndex: 1,
          traceAddress: [],
          error: null,
          action: { from: wallet, to: ethFlow, value: 10n ** 21n, sighash: CREATE_ORDER, input: CREATE_ORDER },
          result: { output: "0x" + "cd".repeat(32) },
        },
        {
          type: "call",
          transactionIndex: 1,
          traceAddress: [0],
          error: null,
          action: { from: stranger, to: ethFlow, sighash: CREATE_ORDER },
        },
      ],
    },
    filter,
  );
  assert.deepEqual(records.map((r) => r.id), ["7:3", "7:4", "7:1:trace:"]);
  const [t, tr, call] = records.map((r) => r.data as Record<string, any>);
  assert.equal(t!.args.value, 2n ** 70n);
  assert.equal(tr!.args.orderUid, "0x" + "ab".repeat(56));
  assert.equal(call!.output, "0x" + "cd".repeat(32));
  assert.equal(call!.tx_hash, "0x" + "11".repeat(32));
});
