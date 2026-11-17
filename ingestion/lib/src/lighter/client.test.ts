import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createLighterClient, lighterEnv, retryAfterMs, RETRY_AFTER_CAP_MS, type Clock } from "#src/lighter/client.ts";

/** `status` 0 drops the connection instead of answering. */
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const market = (market_id: number, symbol: string, market_type: string, status = "active") => ({
  market_id,
  symbol,
  market_type,
  size_decimals: 4,
  price_decimals: 2,
  status,
});

const DETAILS = {
  code: 200,
  order_book_details: [market(0, "ETH", "perp"), market(1, "BTC", "perp"),
    market(8286, "ASELS", "perp", "inactive"),
    market(10635, "ASELS", "perp"),
    market(7001, "GONE", "perp", "inactive"),
    market(7002, "GONE", "perp", "inactive"),
    market(7003, "RESOLV", "perp", "inactive"),
  ],
  spot_order_book_details: [market(2048, "ETH/USDC", "spot")],
};

/** Lighter's API on a local port. `replies` scripts the answers to `/api/v1/x`, one per request. */
async function fakeLighter(t: TestContext, replies: Reply[], delayMs = 0) {
  const requests: string[] = [];
  const state = { inFlight: 0, maxInFlight: 0 };
  const server = createServer(async (req, res) => {
    requests.push(req.url!);
    state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    state.inFlight--;
    const { pathname } = new URL(req.url!, "http://lighter");
    const { status, body, headers } =
      pathname === "/api/v1/orderBookDetails"
        ? { status: 200, body: DETAILS }
        : (replies.shift() ?? { status: 200, body: { code: 200 } });
    if (status === 0) return void req.socket.destroy();
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, state };
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

async function setup(t: TestContext, replies: Reply[] = [], { perMinute = 15, delayMs = 0 } = {}) {
  const { url, requests, state } = await fakeLighter(t, replies, delayMs);
  const clock = fakeClock();
  const client = createLighterClient(
    lighterEnv.parse({ LIGHTER_API_URL: url, LIGHTER_REQUESTS_PER_MINUTE: String(perMinute) }),
    clock,
  );
  return { client, clock, requests, state };
}

test("spaces requests by 60000 / LIGHTER_REQUESTS_PER_MINUTE ms", async (t) => {
  const { client, clock } = await setup(t);
  for (let i = 0; i < 3; i++) await client.get("/api/v1/x");
  assert.deepEqual(clock.sleeps, [4000, 4000]);
});

test("a 429 waits and is sent again", async (t) => {
  const { client, clock, requests } = await setup(t, [
    { status: 429, body: { code: 429, message: "slow down" } },
    { status: 200, body: { code: 200, x: 1 } },
  ]);
  assert.deepEqual(await client.get("/api/v1/x"), { code: 200, x: 1 });
  assert.equal(requests.length, 2);
  // 4000 ms spacing less the 2000 ms retry wait leaves 2000 ms more.
  assert.deepEqual(clock.sleeps, [2000, 2000]);
});

test("retries wait 2 s, 10 s, then 60 s, and the fourth failure is thrown", async (t) => {
  const down = { status: 429, body: { code: 429, message: "slow down" } };
  // 60 a minute spaces requests by 1000 ms, so every sleep here is a retry wait.
  const { client, clock, requests } = await setup(t, [down, down, down, down], { perMinute: 60 });
  await assert.rejects(client.get("/api/v1/x"), /HTTP 429/);
  assert.equal(requests.length, 4);
  assert.deepEqual(clock.sleeps, [2000, 10_000, 60_000]);
});

test("a 405, a 5xx and a dropped connection are each sent again", async (t) => {
  const { client, clock, requests } = await setup(
    t,
    [
      { status: 405, body: { code: 405, message: "blocked" } },
      { status: 503, body: { code: 503, message: "down" } },
      { status: 0, body: null },
      { status: 200, body: { code: 200, x: 2 } },
    ],
    { perMinute: 60 },
  );
  assert.deepEqual(await client.get("/api/v1/x"), { code: 200, x: 2 });
  assert.equal(requests.length, 4);
  assert.deepEqual(clock.sleeps, [2000, 10_000, 60_000]);
});

const slow = (headers: Record<string, string>): Reply => ({ status: 429, body: { code: 429, message: "slow down" }, headers });
const ok: Reply = { status: 200, body: { code: 200 } };

test("Retry-After in seconds replaces the first retry wait", async (t) => {
  // 60 a minute spaces requests by 1000 ms, so the only sleep is the retry wait.
  const { client, clock } = await setup(t, [slow({ "retry-after": "5" }), ok], { perMinute: 60 });
  await client.get("/api/v1/x");
  assert.deepEqual(clock.sleeps, [5000]);
});

test("Retry-After as an HTTP date waits until that date", async (t) => {
  const date = new Date(1_000_000 + 7000).toUTCString();
  const { client, clock } = await setup(t, [slow({ "retry-after": date }), ok], { perMinute: 60 });
  await client.get("/api/v1/x");
  assert.deepEqual(clock.sleeps, [7000]);
});

test("a Retry-After above the cap waits the cap", async (t) => {
  const { client, clock } = await setup(t, [slow({ "retry-after": "86400" }), ok], { perMinute: 60 });
  await client.get("/api/v1/x");
  assert.deepEqual(clock.sleeps, [RETRY_AFTER_CAP_MS]);
});

test("an invalid Retry-After falls back to the retry wait", async (t) => {
  const { client, clock } = await setup(t, [slow({ "retry-after": "soon" }), ok], { perMinute: 60 });
  await client.get("/api/v1/x");
  assert.deepEqual(clock.sleeps, [2000]);
});

test("Retry-After does not add attempts", async (t) => {
  const down = slow({ "retry-after": "1" });
  const { client, requests } = await setup(t, [down, down, down, down, down], { perMinute: 60 });
  await assert.rejects(client.get("/api/v1/x"), /HTTP 429/);
  assert.equal(requests.length, 4);
});

test("retryAfterMs reads seconds, decimals and HTTP dates, and refuses the rest", () => {
  assert.equal(retryAfterMs("5", 0), 5000);
  assert.equal(retryAfterMs("0", 0), 0);
  assert.equal(retryAfterMs("1.5", 0), 1500);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4000), 6000);
  assert.equal(retryAfterMs(new Date(1000).toUTCString(), 4000), 0);
  assert.equal(retryAfterMs("-3", 0), undefined);
  assert.equal(retryAfterMs("soon", 0), undefined);
  assert.equal(retryAfterMs("", 0), undefined);
  assert.equal(retryAfterMs(null, 0), undefined);
});

test("concurrent gets run one at a time, spaced as in a row", async (t) => {
  const { client, clock, requests, state } = await setup(t, [], { delayMs: 20 });
  await Promise.all([client.get("/api/v1/x"), client.get("/api/v1/x"), client.get("/api/v1/x")]);
  assert.equal(requests.length, 3);
  assert.equal(state.maxInFlight, 1);
  assert.deepEqual(clock.sleeps, [4000, 4000]);
});

test("a 400 fails at once, quoting Lighter's message", async (t) => {
  const { client, requests } = await setup(t, [
    { status: 400, body: { code: 20001, message: "invalid param : auth required" } },
  ]);
  await assert.rejects(client.get("/api/v1/x"), /HTTP 400 .*20001.*invalid param : auth required/);
  assert.equal(requests.length, 1);
});

test("a reply whose code is not 200 fails", async (t) => {
  const { client } = await setup(t, [{ status: 200, body: { code: 21500, message: "x" } }]);
  await assert.rejects(client.get("/api/v1/x"), /code 21500/);
});

test("resolveMarkets finds perp and spot symbols and fails on an unknown one, naming it", async (t) => {
  const { client } = await setup(t);
  assert.deepEqual(
    (await client.resolveMarkets(["ETH", "ETH/USDC", "ETH"])).map((m) => m.market_id),
    [0, 2048],
  );
  await assert.rejects(client.resolveMarkets(["DOGE2"]), /DOGE2/);
});

test("resolveMarkets takes the active market when a symbol names several", async (t) => {
  const { client } = await setup(t);
  assert.deepEqual((await client.resolveMarkets(["ASELS"])).map((m) => m.market_id), [10635]);
});

test("resolveMarkets takes the only market a symbol names, even when inactive", async (t) => {
  const { client } = await setup(t);
  assert.deepEqual((await client.resolveMarkets(["RESOLV"])).map((m) => m.market_id), [7003]);
});

test("resolveMarkets fails on a symbol with no single active market, naming every id", async (t) => {
  const { client } = await setup(t);
  await assert.rejects(client.resolveMarkets(["GONE"]), /GONE.*7001.*7002/);
});

test("lighterEnv defaults the mainnet URL and 15 a minute, and refuses more than 60", () => {
  assert.deepEqual(lighterEnv.parse({}), {
    LIGHTER_API_URL: "https://mainnet.zklighter.elliot.ai",
    LIGHTER_REQUESTS_PER_MINUTE: 15,
  });
  assert.throws(() => lighterEnv.parse({ LIGHTER_REQUESTS_PER_MINUTE: "61" }));
});
