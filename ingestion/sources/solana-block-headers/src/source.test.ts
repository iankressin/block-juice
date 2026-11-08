// The source runs against a fake Portal and a fake RPC over HTTP. The fake chain is a specification
// fixture: one slot every ten minutes from slot 1000, so the 2026-11-06 midnight falls on slot 1050
// and the 2026-11-07 midnight on slot 1194. Slot 1049, just before the first, was skipped.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Batch } from "@ingestion/lib";
import { firstSlotAtOrAfter } from "#src/headers.ts";
import {
  MIDNIGHTS_MAX,
  midnights,
  solanaBlockHeaders,
  type HeadersEnv,
  type MidnightCall,
} from "#src/source.ts";

const NOV_6 = Date.parse("2026-11-06T00:00:00Z") / 1000;
const NOV_7 = NOV_6 + 86_400;
const HEAD = 1300;
const SKIPPED = new Set([1049, 1193]);
const timeOf = (slot: number) => NOV_6 + (slot - 1050) * 600;
const hashOf = (slot: number) => `Hash${slot}Abc`;
const produced = Array.from({ length: HEAD - 999 }, (_, i) => 1000 + i).filter((slot) => !SKIPPED.has(slot));
const parentOf = (slot: number) => produced[produced.indexOf(slot) - 1] ?? slot - 1;

async function serve(t: TestContext, answer: (url: string, body: string) => { status?: number; body: string }) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const reply = answer(req.url ?? "", body);
    res.statusCode = reply.status ?? 200;
    res.setHeader("content-type", req.url?.endsWith("stream") ? "application/jsonl" : "application/json");
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A Portal with the fixture's slots. Its timestamp route answers `guess`, right or not. */
function fakePortal(t: TestContext, guess: (time: number) => number) {
  return serve(t, (url, body) => {
    if (url === "/finalized-head") return { body: JSON.stringify({ number: HEAD, hash: hashOf(HEAD) }) };
    const timestamp = /^\/timestamps\/(\d+)\/block$/.exec(url);
    if (timestamp) return { body: JSON.stringify({ block_number: guess(Number(timestamp[1])) }) };
    assert.equal(url, "/finalized-stream");
    const query = JSON.parse(body);
    assert.equal(query.includeAllBlocks, true);
    const lines = produced
      .filter((slot) => slot >= query.fromBlock && slot <= query.toBlock)
      .map((slot) => {
        const header = { number: slot, hash: hashOf(slot), parentNumber: parentOf(slot), parentHash: hashOf(parentOf(slot)) };
        return JSON.stringify({ header: { ...header, timestamp: timeOf(slot) } });
      });
    return { body: lines.join("\n") };
  });
}

/** An RPC that answers getBlock for produced slots, and fails each slot in `failing` once. */
function fakeRpc(t: TestContext, { failing = new Set<number>(), timeless = new Set<number>() } = {}) {
  return serve(t, (_url, body) => {
    const { id, method, params } = JSON.parse(body);
    assert.equal(method, "getBlock");
    const [slot, config] = params;
    // Kit drops commitment "finalized" from the request: it is what the RPC reads without one.
    assert.deepEqual(config, {
      maxSupportedTransactionVersion: 0,
      rewards: false,
      transactionDetails: "none",
    });
    if (failing.delete(slot)) {
      return { body: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "upstream busy" } }) };
    }
    const result = {
      blockHeight: slot - 100,
      blockTime: timeless.has(slot) ? null : timeOf(slot),
      blockhash: hashOf(slot),
      parentSlot: parentOf(slot),
      previousBlockhash: hashOf(parentOf(slot)),
    };
    return { body: JSON.stringify({ jsonrpc: "2.0", id, result }) };
  });
}

const env = (portal: string, rpc: string, overrides: Partial<HeadersEnv> = {}): HeadersEnv => ({
  PORTAL_URL: portal,
  SOLANA_RPC_URL: rpc,
  SOLANA_RPC_INTERVAL_MS: 0,
  START_DATE: "2026-11-06",
  ...overrides,
});

async function run(env: HeadersEnv, retry: MidnightCall[] = []) {
  const batches: Batch<MidnightCall>[] = [];
  for await (const batch of solanaBlockHeaders.extract(env, retry)) batches.push(batch);
  return {
    records: batches.flatMap((batch) => batch.records),
    failed: batches.flatMap((batch) => batch.failed),
  };
}

const exact = (time: number) => produced.find((slot) => timeOf(slot) >= time)!;
const MIDNIGHT_6 = "2026-11-06T00:00:00.000Z";
const MIDNIGHT_7 = "2026-11-07T00:00:00.000Z";

test("each midnight up to the finalized head gets its boundary and the headers of both origins", async (t) => {
  const { records, failed } = await run(env(await fakePortal(t, exact), await fakeRpc(t)));
  assert.deepEqual(failed, []);
  assert.deepEqual(
    records.map((r) => `${r.callId} ${r.id}`),
    [
      `${MIDNIGHT_6} boundary:${MIDNIGHT_6}`,
      `${MIDNIGHT_6} portal:1048`,
      `${MIDNIGHT_6} portal:1050`,
      `${MIDNIGHT_6} rpc:1048`,
      `${MIDNIGHT_6} rpc:1050`,
      `${MIDNIGHT_7} boundary:${MIDNIGHT_7}`,
      `${MIDNIGHT_7} portal:1192`,
      `${MIDNIGHT_7} portal:1194`,
      `${MIDNIGHT_7} rpc:1192`,
      `${MIDNIGHT_7} rpc:1194`,
    ],
    "the slot before each boundary is the last produced one: 1049 and 1193 were skipped",
  );
  const data = (id: string) => records.find((r) => r.id === id)!.data;
  assert.deepEqual(data(`boundary:${MIDNIGHT_6}`), { kind: "boundary", midnight: MIDNIGHT_6, block: 1050 });
  assert.deepEqual(data("rpc:1050"), {
    kind: "header",
    origin: "rpc",
    number: 1050,
    hash: hashOf(1050),
    parent_hash: hashOf(1048),
    parent_number: 1048,
    timestamp: MIDNIGHT_6,
  });
  assert.deepEqual(data("portal:1048"), { ...data("rpc:1048"), origin: "portal" });
});

test("Portal's timestamp route is a guess: the boundary is the first slot whose header is at or after midnight", async (t) => {
  const rpc = await fakeRpc(t);
  for (const wrong of [0, 1001, 1049, 1051, 1150, HEAD]) {
    const { records, failed } = await run(env(await fakePortal(t, () => wrong), rpc, { END_DATE: "2026-11-06" }));
    assert.deepEqual(failed, [], `guess ${wrong}`);
    assert.deepEqual(records[0]?.data, { kind: "boundary", midnight: MIDNIGHT_6, block: 1050 }, `guess ${wrong}`);
  }
});

test("a rerun writes the same rows", async (t) => {
  const settings = env(await fakePortal(t, exact), await fakeRpc(t));
  assert.deepEqual(await run(settings), await run(settings));
});

test("an RPC blockTime of null stays null", async (t) => {
  const { records } = await run(env(await fakePortal(t, exact), await fakeRpc(t, { timeless: new Set([1194]) })));
  assert.equal(records.find((r) => r.id === "rpc:1194")!.data.timestamp, null);
  assert.equal(records.find((r) => r.id === "portal:1194")!.data.timestamp, MIDNIGHT_7);
});

test("a failed RPC call is a dead letter keyed by its midnight, and its retry clears it", async (t) => {
  const portal = await fakePortal(t, exact);
  const rpc = await fakeRpc(t, { failing: new Set([1050]) });
  const first = await run(env(portal, rpc));
  assert.deepEqual(
    first.failed.map(({ id, call }) => ({ id, call })),
    [{ id: MIDNIGHT_6, call: { kind: "block_headers", midnight: MIDNIGHT_6 } }],
  );
  assert.match(first.failed[0]!.error, /upstream busy/);
  assert.equal(first.records.some((r) => r.callId === MIDNIGHT_6), false, "no part of a failed midnight is written");

  const call = solanaBlockHeaders.call.parse(JSON.parse(JSON.stringify(first.failed[0]!.call)));
  const retried = await run(env(portal, rpc, { START_DATE: "2026-11-07" }), [call]);
  assert.deepEqual(retried.failed, []);
  assert.deepEqual(
    retried.records.filter((r) => r.callId === MIDNIGHT_6).map((r) => r.id),
    [`boundary:${MIDNIGHT_6}`, "portal:1048", "portal:1050", "rpc:1048", "rpc:1050"],
  );
});

test("midnights run from START_DATE to END_DATE and the head, at most MIDNIGHTS_MAX a run", () => {
  const head = Date.parse("2026-11-08T09:30:00Z");
  assert.deepEqual(midnights({ START_DATE: "2026-11-06" }, head), [
    MIDNIGHT_6,
    MIDNIGHT_7,
    "2026-11-08T00:00:00.000Z",
  ]);
  assert.deepEqual(midnights({ START_DATE: "2026-11-06", END_DATE: "2026-11-06" }, head), [MIDNIGHT_6]);
  assert.deepEqual(midnights({ START_DATE: "2026-11-09" }, head), [], "no midnight past the head");
  assert.equal(midnights({ START_DATE: "2024-02-13" }, Date.parse("2026-11-08T00:00:00Z")).length, MIDNIGHTS_MAX);
  assert.throws(() => midnights({ START_DATE: "2024-02-12" }, Date.parse("2026-11-08T00:00:00Z")), /more than 1000/);
});

test("the search finds the same slot from any guess, past skipped slots", async () => {
  const timeAt = async (slot: number) => timeOf(produced.find((p) => p >= slot) ?? Infinity);
  for (let guess = 1000; guess <= HEAD; guess += 7) {
    assert.equal(await firstSlotAtOrAfter(NOV_6, guess, HEAD, timeAt), 1049, `guess ${guess}`);
    assert.equal(await firstSlotAtOrAfter(NOV_7, guess, HEAD, timeAt), 1193, `guess ${guess}`);
  }
  assert.equal(await firstSlotAtOrAfter(timeOf(HEAD) + 1, 1100, HEAD, timeAt), HEAD + 1, "past the head");
});
