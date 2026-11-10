import assert from "node:assert/strict";
import { test } from "node:test";
import { blockRecords, chainName, forChain } from "#src/source.ts";

// Block 26366424's transaction 14 calls 0x069c…c5ea, which creates a minimal proxy two frames down
// (trace address [0, 0]). Transaction 15 creates nothing: Portal still sends its state diffs, since a trace
// request cannot ask for them, and the source drops them.
const block = {
  header: { number: 26366424, timestamp: 1794096011 },
  transactions: [
    {
      transactionIndex: 14,
      hash: "0xc7b2766c6e2e4bde1106a595dea8f1a15712d4d8453cbd7a53760d59dc238611",
      from: "0x2307278fc8ab0005974a6ded2fa6d1187333a223",
      to: "0x069c4c579671f8c120b1327a73217d01ea2ec5ea",
      sighash: "0x82ecf2f6",
      type: 2,
      status: 1,
    },
  ],
  traces: [
    {
      type: "call",
      transactionIndex: 14,
      traceAddress: [],
      subtraces: 1,
      error: null,
      action: { from: "0x2307278fc8ab0005974a6ded2fa6d1187333a223", to: "0x069c4c579671f8c120b1327a73217d01ea2ec5ea" },
    },
    {
      type: "create",
      transactionIndex: 14,
      traceAddress: [0, 0],
      subtraces: 0,
      error: null,
      action: { from: "0x069c4c579671f8c120b1327a73217d01ea2ec5ea", value: 0n },
      result: { address: "0x00000000000000000000000000000000000000c1", code: "0x363d3d37" },
    },
  ],
  stateDiffs: [
    { transactionIndex: 14, address: "0x00000000000000000000000000000000000000c1", key: "balance", kind: "+", next: "0x0" },
    {
      transactionIndex: 14,
      address: "0x069c4c579671f8c120b1327a73217d01ea2ec5ea",
      key: "0x0000000000000000000000000000000000000000000000000000000000000001",
      kind: "*",
      prev: "0x0000000000000000000000000000000000000000000000000000000000000000",
      next: "0x0000000000000000000000000000000000000000000000000000000000000002",
    },
    { transactionIndex: 15, address: "0x00000000000000000000000000000000000000aa", key: "nonce", kind: "*", prev: "0x1", next: "0x2" },
  ],
};

test("a transaction with a create trace becomes records: the transaction, its traces and its state diffs", () => {
  const records = blockRecords(block);
  assert.deepEqual(
    records.map((r) => r.id),
    [
      "tx:0xc7b2766c6e2e4bde1106a595dea8f1a15712d4d8453cbd7a53760d59dc238611",
      "26366424:14:trace:",
      "26366424:14:trace:0.0",
      "26366424:14:diff:0x00000000000000000000000000000000000000c1:balance",
      "26366424:14:diff:0x069c4c579671f8c120b1327a73217d01ea2ec5ea:0x0000000000000000000000000000000000000000000000000000000000000001",
    ],
    "transaction 15 has no create trace, so its state diff is left out",
  );
  for (const r of records) assert.equal(r.callId, r.id);
  assert.deepEqual(records[2]!.data, {
    kind: "trace",
    trace_type: "create",
    transaction_index: 14,
    trace_address: [0, 0],
    subtraces: 0,
    error: null,
    revert_reason: null,
    action: { from: "0x069c4c579671f8c120b1327a73217d01ea2ec5ea", value: 0n },
    result: { address: "0x00000000000000000000000000000000000000c1", code: "0x363d3d37" },
    block_number: 26366424,
    timestamp: "2026-11-08T00:00:11.000Z",
  });
  assert.deepEqual(records[4]!.data, {
    kind: "state_diff",
    transaction_index: 14,
    address: "0x069c4c579671f8c120b1327a73217d01ea2ec5ea",
    key: "0x0000000000000000000000000000000000000000000000000000000000000001",
    diff_kind: "*",
    prev: "0x0000000000000000000000000000000000000000000000000000000000000000",
    next: "0x0000000000000000000000000000000000000000000000000000000000000002",
    block_number: 26366424,
    timestamp: "2026-11-08T00:00:11.000Z",
  });
});

test("a block with no create trace writes nothing", () => {
  assert.deepEqual(blockRecords({ ...block, traces: [block.traces[0]!] }), []);
});

test("each chain loads its own table", () => {
  const source = forChain("ethereum");
  assert.equal(source.name, "ethereum");
  assert.equal(source.table, "contract_deployments");
  assert.throws(() => chainName.parse("Ethereum"));
});
