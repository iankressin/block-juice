import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal, type MockPortalBlock } from "@subsquid/pipes/testing";
import { source } from "#src/source.ts";

const zeroHash = `0x${"0".repeat(64)}`;
const wallet = "0x6978e7917dffd1f1815c858ca1528e51a3af1cb5";
const checksummed = "0x6978E7917dffD1f1815c858ca1528E51a3AF1CB5";

// Actions 13 and 570 of block 1223800001 as Portal sent them. The wallet cancels three orders by cloid
// and two of the cancels fail, yet the action's status is ok. Then it rests two orders for asset 223.
const cancelByCloid = {
  actionIndex: 13, user: wallet,
  action: {
    type: "cancelByCloid",
    cancels: [
      { asset: 203, cloid: "0x9803ba672ed60000000000000763932f" },
      { asset: 0, cloid: "0x9803ba672ed6000000000000076393d5" },
      { asset: 0, cloid: "0x9803ba672ed6000000000000076393d7" },
    ],
    f: true,
  },
  signature: {
    r: "0x323289864f49abc47de757b949d96c1250fbc5d7926fe5da09e43167e329a648",
    s: "0x67ba56ec5b4b242d1ba82f82546dac5c712259d52270f8a26e68f39f2cf38606",
    v: 27,
  },
  nonce: 1794861532566, vaultAddress: wallet, status: "ok",
  response: {
    type: "cancel",
    data: {
      statuses: [
        "success",
        { error: "Order was never placed, already canceled, or filled. asset=0" },
        { error: "Order was never placed, already canceled, or filled. asset=0" },
      ],
    },
  },
};
const order = {
  actionIndex: 570, user: wallet,
  action: {
    type: "order",
    orders: [
      { a: 223, b: true, p: "2.6816", s: "5", r: false, t: { limit: { tif: "Alo" } }, c: "0x9803ba672ed600000000000007639425" },
      { a: 223, b: true, p: "2.6814", s: "5", r: false, t: { limit: { tif: "Alo" } }, c: "0x9803ba672ed600000000000007639426" },
    ],
    grouping: "na",
  },
  signature: {
    r: "0x8f4bd7115ccac7646408e8d08c934c0819518f0a1c39638bd3f942e62d5c2060",
    s: "0x6815dab64972400b23745c825dc4d08b38cd8348bff732eed5f89a5812668138",
    v: 27,
  },
  nonce: 1794861532573, vaultAddress: wallet, status: "ok",
  response: {
    type: "order",
    data: {
      statuses: [
        { resting: { oid: 607436620785, cloid: "0x9803ba672ed600000000000007639425" } },
        { resting: { oid: 607436620786, cloid: "0x9803ba672ed600000000000007639426" } },
      ],
    },
  },
};
// Action 301 of block 1223800003, Portal's fields but the signature: a user acting for itself, with no
// vault, whose leverage change failed and whose response is a plain string.
const rejected = {
  actionIndex: 301, user: "0x7fcaf827925e3c30e0c32fca3a2f384006d56b8d",
  action: { type: "updateLeverage", asset: 86, isCross: true, leverage: 6 },
  nonce: 1794861533048, vaultAddress: null, status: "err", response: "Invalid leverage value",
};

const block = (number: number, actions: object[], timestamp = number * 1000): MockPortalBlock => ({
  header: { number, hash: zeroHash, parentHash: zeroHash, timestamp },
  actions,
});

/** Runs the rest of the test from a folder whose addresses.json holds `json`, as a source runs from its package. */
async function addressesHold(t: TestContext, json: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "hypercore-actions-"));
  const cwd = process.cwd();
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true });
  });
  await writeFile(join(dir, "addresses.json"), typeof json === "string" ? json : JSON.stringify(json));
  process.chdir(dir);
}

/** Streams the source from a mock Portal holding `blocks`, and returns the records and the requests it sent. */
async function run(t: TestContext, blocks: MockPortalBlock[], range: { START_BLOCK: number; END_BLOCK?: number }) {
  const portal = await mockPortal({ blocks });
  t.after(() => portal.close());
  const stream = await source.stream({ PORTAL_URL: portal.url, ...range });
  const read: RawRecord[] = [];
  for await (const { data } of stream) read.push(...(Array.isArray(data) ? data : Object.values(data).flat()));
  return { read, requests: portal.requests };
}

test("each action becomes a record keyed by block and action index, with every field but the signature", async (t) => {
  await addressesHold(t, { users: [wallet] });
  const { read } = await run(t, [block(1223800001, [cancelByCloid, order], 1794861532843)], {
    START_BLOCK: 1223800000,
  });

  const timestamp = "2026-11-16T20:38:52.843Z";
  const { signature: _1, ...cancelLoaded } = cancelByCloid;
  const { signature: _2, ...orderLoaded } = order;
  assert.deepEqual(read, [
    { id: "1223800001:13", callId: "1223800001:13", data: { block_number: 1223800001, timestamp, action: cancelLoaded } },
    { id: "1223800001:570", callId: "1223800001:570", data: { block_number: 1223800001, timestamp, action: orderLoaded } },
  ]);
});

test("a rejected action keeps its null vaultAddress and its string response", async (t) => {
  await addressesHold(t, { users: [rejected.user] });
  const { read } = await run(t, [block(1223800003, [rejected], 1794861532975)], { START_BLOCK: 1223800003 });
  assert.deepEqual(read.map((r) => r.data.action), [rejected]);
});

test("a block without actions loads nothing", async (t) => {
  await addressesHold(t, { users: [wallet] });
  // Portal sends the range's last block with its header alone, with no actions key, as it does every
  // block with no match.
  const bare = { header: { number: 3, hash: zeroHash, parentHash: zeroHash, timestamp: 3000 } };
  const { read } = await run(t, [bare], { START_BLOCK: 3 });
  assert.deepEqual(read, []);
});

test("a status other than ok or err fails the run", async (t) => {
  await addressesHold(t, { users: [wallet] });
  await assert.rejects(
    run(t, [block(1, [{ ...order, status: "pending" }])], { START_BLOCK: 1 }),
    /invalid value at \/actions\/0\/status: given value does not match/,
  );
});

test("the stream starts at START_BLOCK and stops at END_BLOCK", async (t) => {
  await addressesHold(t, { users: [wallet] });
  const blocks = [1, 2, 3, 4].map((number) => block(number, [order]));
  const { read } = await run(t, blocks, { START_BLOCK: 2, END_BLOCK: 3 });
  assert.deepEqual(read.map((r) => r.id), ["2:570", "3:570"]);
});

test("addresses.json's users go out lowercased in one action request, which selects no signature", async (t) => {
  await addressesHold(t, { users: [checksummed] });
  const { requests } = await run(t, [block(1, [order])], { START_BLOCK: 1 });
  assert.ok(requests.length > 0, "the source sent a stream request");
  for (const { query } of requests) {
    const { fromBlock: _1, toBlock: _2, parentBlockHash: _3, ...request } = query;
    assert.deepEqual(request, {
      type: "hyperliquidReplicaCmds",
      fields: {
        block: { number: true, hash: true, timestamp: true },
        action: { actionIndex: true, user: true, action: true, nonce: true, vaultAddress: true, status: true, response: true },
      },
      actions: [{ user: [wallet] }],
    });
  }
});

for (const [holds, json, message] of [
  ["no users key", '{ "coins": ["HYPE"] }', /^addresses\.json lists no users\. List at least one: HyperCore users send about 1\.2 billion/],
  ["an empty list of users", '{ "users": [] }', /^addresses\.json lists no users\. List at least one/],
  ["an invalid user", '{ "users": ["0x123"] }', /^Invalid Ethereum addresses:\n {2}0x123$/],
  ["a user that is not in a list", `{ "users": "${wallet}" }`, /^addresses\.json: users must be a list of addresses$/],
] as const) {
  test(`an addresses.json with ${holds} fails the run, not the import`, async (t) => {
    await addressesHold(t, json);
    await assert.rejects(run(t, [block(1, [order])], { START_BLOCK: 1 }), { message });
  });
}
