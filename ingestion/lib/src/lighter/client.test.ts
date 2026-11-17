import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { createLighterClient, lighterEnv, type Clock } from "#src/lighter/client.ts";

type Reply = { status: number; body: unknown };

const market = (market_id: number, symbol: string, market_type: string) => ({
  market_id,
  symbol,
  market_type,
  size_decimals: 4,
  price_decimals: 2,
  status: "active",
});

const DETAILS = {
  code: 200,
  order_book_details: [market(0, "ETH", "perp"), market(1, "BTC", "perp")],
  spot_order_book_details: [market(2048, "ETH/USDC", "spot")],
};

/** Lighter's API on a local port. `replies` scripts the answers to `/api/v1/x`, one per request. */
async function fakeLighter(t: TestContext, replies: Reply[]) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const { pathname } = new URL(req.url!, "http://lighter");
    const { status, body } =
      pathname === "/api/v1/orderBookDetails"
        ? { status: 200, body: DETAILS }
        : (replies.shift() ?? { status: 200, body: { code: 200 } });
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
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

async function setup(t: TestContext, replies: Reply[] = []) {
  const { url, requests } = await fakeLighter(t, replies);
  const clock = fakeClock();
  const client = createLighterClient(
    lighterEnv.parse({ LIGHTER_API_URL: url, LIGHTER_REQUESTS_PER_MINUTE: "15" }),
    clock,
  );
  return { client, clock, requests };
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
  assert.equal(clock.sleeps.includes(2000), true);
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

test("lighterEnv defaults the mainnet URL and 15 a minute, and refuses more than 60", () => {
  assert.deepEqual(lighterEnv.parse({}), {
    LIGHTER_API_URL: "https://mainnet.zklighter.elliot.ai",
    LIGHTER_REQUESTS_PER_MINUTE: 15,
  });
  assert.throws(() => lighterEnv.parse({ LIGHTER_REQUESTS_PER_MINUTE: "61" }));
});
