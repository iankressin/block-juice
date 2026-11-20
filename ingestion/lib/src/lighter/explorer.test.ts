import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Clock } from "#src/lighter/client.ts";
import {
  createExplorerClient,
  DETAIL_TYPES,
  LEDGER_TYPES,
  lighterExplorerEnv,
} from "#src/lighter/explorer.ts";

type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Seen = { path: string; query: URLSearchParams };

/** The Explorer on a local port. `replies` scripts the answers to the next requests; an empty script answers 200 `[]`. */
async function fakeExplorer(t: TestContext, replies: Reply[]) {
  const requests: Seen[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://explorer");
    requests.push({ path: url.pathname, query: url.searchParams });
    const { status, body, headers } = replies.shift() ?? { status: 200, body: [] };
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A clock that a sleep moves forward at once. `sleeps` gets each wait. */
function fakeClock(): Clock & { sleeps: number[] } {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

async function setup(t: TestContext, replies: Reply[] = [], perMinute = 15) {
  const { url, requests } = await fakeExplorer(t, replies);
  const clock = fakeClock();
  const explorer = createExplorerClient(
    lighterExplorerEnv.parse({
      LIGHTER_EXPLORER_URL: url,
      LIGHTER_EXPLORER_WEIGHT_PER_MINUTE: String(perMinute),
    }),
    clock,
  );
  return { explorer, clock, requests };
}

test("paces requests by weight: a weight-4 page, then two weight-1 reads at 15 a minute", async (t) => {
  const { explorer, clock } = await setup(t, [
    { status: 200, body: [] },
    { status: 200, body: { batch_number: 270063 } },
    { status: 200, body: { batch_number: 270064 } },
  ]);
  await explorer.accountLogs(313004, { limit: 100, offset: 0 });
  await explorer.batch(270063);
  await explorer.batch(270064);
  assert.deepEqual(clock.sleeps, [16000, 4000]);
});

test("accountLogs asks for every ledger type in one comma-separated pub_data_type, never Trade", async (t) => {
  const { explorer, requests } = await setup(t);
  await explorer.accountLogs(1000, { limit: 100, offset: 200 });
  const q = requests[0]!.query;
  assert.equal(requests[0]!.path, "/api/accounts/1000/logs");
  assert.equal(q.getAll("pub_data_type").length, 1);
  assert.deepEqual(q.get("pub_data_type")!.split(","), [...LEDGER_TYPES]);
  assert.equal(LEDGER_TYPES.length, 39);
  assert.equal(LEDGER_TYPES.includes("Trade"), false);
  assert.equal(LEDGER_TYPES.includes("Empty"), false);
  assert.equal(LEDGER_TYPES.includes("TradeWithFunding"), true);
  assert.deepEqual([q.get("limit"), q.get("offset")], ["100", "200"]);
});

test("every detail type is a ledger type", () => {
  assert.equal(DETAIL_TYPES.length, 14);
  for (const type of DETAIL_TYPES) assert.equal(LEDGER_TYPES.includes(type), true, type);
});

test("a 404 batch reads as undefined; a 404 log fails, quoting the error", async (t) => {
  const { explorer, requests } = await setup(t, [
    { status: 404, body: { error: "batch=28909 not found with block=0" } },
    { status: 404, body: { error: "log deadbeef not found" } },
  ]);
  assert.equal(await explorer.batch(28909), undefined);
  await assert.rejects(explorer.log("deadbeef"), {
    message: "Lighter's Explorer answered HTTP 404 for /api/logs/deadbeef: log deadbeef not found",
  });
  assert.deepEqual(requests.map((r) => r.path), ["/api/batches/28909", "/api/logs/deadbeef"]);
});

test("a 400 fails at once, quoting the Explorer's error", async (t) => {
  const { explorer, requests, clock } = await setup(t, [{ status: 400, body: { error: "invalid pubDataType=Nope" } }]);
  await assert.rejects(explorer.get("/api/accounts/1/logs", { pub_data_type: "Nope" }, 4), {
    message: "Lighter's Explorer answered HTTP 400 for /api/accounts/1/logs: invalid pubDataType=Nope",
  });
  assert.equal(requests.length, 1);
  assert.deepEqual(clock.sleeps, []);
});

test("a 429 waits and is sent again", async (t) => {
  // At 45 a minute a weight-1 request has no spacing wait beyond the retry's own.
  const { explorer, requests, clock } = await setup(t, [
    { status: 429, body: { error: "slow down" } },
    { status: 200, body: [] },
  ], 45);
  assert.deepEqual(await explorer.recentBatches(), []);
  assert.equal(requests.length, 2);
  assert.deepEqual(clock.sleeps, [2000]);
});

test("a failed weight-4 page still spends its weight: a 429 at 15 a minute waits 2 s, then the rest of the 16 s", async (t) => {
  const { explorer, requests, clock } = await setup(t, [
    { status: 429, body: { error: "slow down" } },
    { status: 200, body: [] },
  ]);
  assert.deepEqual(await explorer.accountLogs(1, { limit: 10, offset: 0 }), []);
  assert.equal(requests.length, 2);
  assert.deepEqual(clock.sleeps, [2000, 14000]);
});

test("a Retry-After sets the wait, capped", async (t) => {
  const { explorer, clock } = await setup(t, [
    { status: 429, body: {}, headers: { "retry-after": "7" } },
    { status: 429, body: {}, headers: { "retry-after": "9999" } },
    { status: 200, body: [] },
  ], 45);
  await explorer.recentBatches();
  assert.deepEqual(clock.sleeps, [7000, 120000]);
});

test("a request that keeps failing stops after three waits of 2 s, 10 s and 60 s", async (t) => {
  const { explorer, requests, clock } = await setup(t, Array.from({ length: 4 }, () => ({ status: 503, body: { error: "down" } })), 45);
  await assert.rejects(explorer.txStats(), /HTTP 503/);
  assert.equal(requests.length, 4);
  assert.deepEqual(clock.sleeps, [2000, 10000, 60000]);
});

test("lighterExplorerEnv defaults the Explorer URL and 15 a minute, and refuses more than 45", () => {
  const env = lighterExplorerEnv.parse({});
  assert.equal(env.LIGHTER_EXPLORER_URL, "https://explorer.elliot.ai");
  assert.equal(env.LIGHTER_EXPLORER_WEIGHT_PER_MINUTE, 15);
  assert.equal(lighterExplorerEnv.parse({ LIGHTER_EXPLORER_WEIGHT_PER_MINUTE: "45" }).LIGHTER_EXPLORER_WEIGHT_PER_MINUTE, 45);
  assert.throws(() => lighterExplorerEnv.parse({ LIGHTER_EXPLORER_WEIGHT_PER_MINUTE: "46" }));
});
