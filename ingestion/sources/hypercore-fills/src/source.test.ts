import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RawRecord } from "@ingestion/lib";
import { mockPortal, type MockPortalBlock } from "@subsquid/pipes/testing";
import { source } from "#src/source.ts";

const zeroHash = `0x${"0".repeat(64)}`;

// Fills 0 and 1 of block 1223800001 as Portal sent them: the taker and maker sides of one io:ANTH trade.
const taker = {
  fillIndex: 0, user: "0x4394eddef02d15107e4999995496888504553498", coin: "io:ANTH", px: 1694.7, sz: 0.008,
  side: "B", time: 1794861532843, startPosition: 16.597, dir: "Open Long", closedPnl: 0.0,
  hash: "0x7efa9ec36a76d43680740448f1b4c102029200a90579f30822c34a16297aae21", oid: 607436620893, crossed: true,
  fee: 0.001171, builderFee: null, tid: 374728780679102, cloid: "0x9e9febb08d0f919e3eeea8fbc96c6026",
  feeToken: "USDC", builder: null, twapId: null,
};
const maker = {
  fillIndex: 1, user: "0x5b52403396a365f9f7e33e87488564017e1f97a8", coin: "io:ANTH", px: 1694.7, sz: 0.008,
  side: "A", time: 1794861532843, startPosition: 0.102, dir: "Close Long", closedPnl: 0.004392,
  hash: "0x7efa9ec36a76d43680740448f1b4c102029200a90579f30822c34a16297aae21", oid: 607436619018, crossed: false,
  fee: -0.00004, builderFee: null, tid: 374728780679102, cloid: "0x00000000000000003e4faf2ac03f55b1",
  feeToken: "USDC", builder: null, twapId: null,
};
// Fill 18 of the same block, a ZEC fill through a builder. Its twapId is made up, since no fill in the
// block has one, so that every optional field carries a value.
const viaBuilder = {
  fillIndex: 18, user: "0xc6347db3a578fbcfd14886421ec918dbbbef8f95", coin: "ZEC", px: 893.05, sz: 0.24,
  side: "B", time: 1794861532843, startPosition: -3.3, dir: "Close Short", closedPnl: 0.62688,
  hash: "0x23dda4cb400c6f2b25570448f1b4c102045300b0db0f8dfdc7a6501dff004915", oid: 607436621393, crossed: true,
  fee: 0.203615, builderFee: 0.107166, tid: 922177073270965, cloid: null, feeToken: "USDC",
  builder: "0x524cbf002a925af7356f2c5c9074179e5c0d571e", twapId: 7,
};

const block = (number: number, fills: object[], timestamp = number * 1000): MockPortalBlock => ({
  header: { number, hash: zeroHash, parentHash: zeroHash, timestamp },
  fills,
});

/** Runs the rest of the test from a folder whose addresses.json holds `json`, as a source runs from its package. */
async function addressesHold(t: TestContext, json: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "hypercore-fills-"));
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

test("each fill becomes a record keyed by block and fill index, with the fill as Portal sent it", async (t) => {
  await addressesHold(t, { coins: ["io:ANTH", "ZEC"] });
  const { read } = await run(t, [block(1223800001, [taker, maker, viaBuilder], 1794861532843)], {
    START_BLOCK: 1223800000,
  });

  const timestamp = "2026-11-16T20:38:52.843Z";
  // Pipes drops a field Portal sends as null; staging reads the missing key as null.
  const { builderFee: _1, builder: _2, twapId: _3, ...takerLoaded } = taker;
  const { builderFee: _4, builder: _5, twapId: _6, ...makerLoaded } = maker;
  const { cloid: _7, ...viaBuilderLoaded } = viaBuilder;
  assert.deepEqual(read, [
    { id: "1223800001:0", callId: "1223800001:0", data: { block_number: 1223800001, timestamp, fill: takerLoaded } },
    { id: "1223800001:1", callId: "1223800001:1", data: { block_number: 1223800001, timestamp, fill: makerLoaded } },
    { id: "1223800001:18", callId: "1223800001:18", data: { block_number: 1223800001, timestamp, fill: viaBuilderLoaded } },
  ]);
});

test("the stream starts at START_BLOCK and stops at END_BLOCK", async (t) => {
  await addressesHold(t, { coins: ["io:ANTH"] });
  const blocks = [1, 2, 3, 4].map((number) => block(number, [{ ...taker, time: number * 1000 }]));
  const { read } = await run(t, blocks, { START_BLOCK: 2, END_BLOCK: 3 });
  assert.deepEqual(read.map((r) => r.id), ["2:0", "3:0"]);
});

const user = "0x6978e7917dffd1f1815c858ca1528e51a3af1cb5";
const checksummed = "0x6978E7917dffD1f1815c858ca1528E51a3AF1CB5";
const coins = ["HYPE", "@107", "xyz:TSLA"];

for (const [holds, addresses, request] of [
  ["users and coins", { users: [checksummed], coins }, { user: [user], coin: coins }],
  ["users only", { users: [checksummed] }, { user: [user] }],
  ["coins only", { coins }, { coin: coins }],
] as const) {
  test(`an addresses.json with ${holds} sends one fill request with them`, async (t) => {
    await addressesHold(t, addresses);
    const { requests } = await run(t, [block(1, [taker])], { START_BLOCK: 1 });
    assert.ok(requests.length > 0, "the source sent a stream request");
    for (const { query } of requests) {
      assert.deepEqual(query.fills, [request], "users go out lowercased, coins exactly as listed");
    }
  });
}

for (const [holds, json, message] of [
  ["neither users nor coins", "{}", /^addresses\.json lists no users and no coins\. List at least one/],
  ["an empty list of users", '{ "users": [] }', /^addresses\.json lists no users\. List at least one, or remove/],
  ["an empty list of coins", '{ "coins": [] }', /^addresses\.json lists no coins\. List at least one, or remove/],
  ["an invalid user", '{ "users": ["0x123"] }', /^Invalid Ethereum addresses:\n {2}0x123$/],
  ["an empty coin name", '{ "coins": ["HYPE", ""] }', /^addresses\.json: coins must be a list of non-empty strings$/],
  ["a coin that is not in a list", '{ "coins": "HYPE" }', /^addresses\.json: coins must be a list of non-empty strings$/],
] as const) {
  test(`an addresses.json with ${holds} fails the run, not the import`, async (t) => {
    await addressesHold(t, json);
    await assert.rejects(run(t, [block(1, [taker])], { START_BLOCK: 1 }), { message });
  });
}

test("a trade id past 2^53 fails the run rather than loading a rounded id", async (t) => {
  await addressesHold(t, { coins: ["io:ANTH"] });
  // 2^53 is what JSON.parse makes of 9007199254740993, the first integer a double cannot hold.
  await assert.rejects(run(t, [block(1, [{ ...taker, tid: 2 ** 53 }])], { START_BLOCK: 1 }), /not a safe natural number/);
});
