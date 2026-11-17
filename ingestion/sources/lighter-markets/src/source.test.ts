import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import type { Batch } from "@ingestion/lib";
import { lighterEnv, type Clock } from "@ingestion/lib/lighter";
import { marketsSource } from "#src/source.ts";

const NOW = 1794918000000;

type Call = { kind: "order_book_details" };

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

/** Lighter's orderBookDetails on a local port. `status` answers every request. */
async function fakeLighter(t: TestContext, status = 200, details: typeof DETAILS = DETAILS) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    const body = status === 200 ? details : { code: status, message: "down" };
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A clock stopped at NOW that a sleep moves forward at once. */
function fakeClock(): Clock {
  let now = NOW;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

async function run(url: string, retry: Call[] = []) {
  const env = lighterEnv.parse({ LIGHTER_API_URL: url });
  const batches: Batch<Call>[] = [];
  for await (const batch of marketsSource(fakeClock()).extract(env, retry)) batches.push(batch);
  return batches;
}

test("each run reads every perp and spot market once, keyed by market and read time", async (t) => {
  const { url } = await fakeLighter(t);
  const [batch] = await run(url);
  assert.deepEqual(
    batch!.records.map((r) => r.id),
    ["0:1794918000000", "1:1794918000000", "2048:1794918000000"],
  );
  assert.equal(batch!.records[2]!.callId, "order_book_details");
  assert.equal((batch!.records[2]!.data.market as { symbol: string }).symbol, "ETH/USDC");
  assert.equal(batch!.records[0]!.data.read_at, NOW);
  assert.deepEqual(batch!.failed, []);
});

test("a failed read waits as a dead letter", async (t) => {
  const { url, requests } = await fakeLighter(t, 500);
  const [batch] = await run(url);
  assert.equal(requests.length, 4);
  assert.equal(batch!.records.length, 0);
  assert.equal(batch!.failed[0]!.id, "order_book_details");
  assert.deepEqual(batch!.failed[0]!.call, { kind: "order_book_details" });
});

test("a retried read is made once, by the run's own call", async (t) => {
  const { url, requests } = await fakeLighter(t);
  const [batch] = await run(url, [{ kind: "order_book_details" }]);
  assert.equal(requests.length, 1);
  assert.equal(batch!.records.length, 3);
});

test("a successful read with no markets still clears the call's dead letter", async (t) => {
  const { url } = await fakeLighter(t, 200, { code: 200, order_book_details: [], spot_order_book_details: [] });
  const batches = await run(url);
  assert.deepEqual(batches.flatMap((b) => b.records), []);
  assert.deepEqual(batches.flatMap((b) => b.failed), []);
  assert.deepEqual(batches.flatMap((b) => b.succeededCallIds ?? []), ["order_book_details"]);
});
