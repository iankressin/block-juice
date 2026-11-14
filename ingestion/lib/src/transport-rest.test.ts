import assert from "node:assert/strict";
import { test } from "node:test";
import { createBinanceClient } from "../../sources/binance-candles/src/binance.ts";
import { createCoinbaseClient } from "../../sources/coinbase-candles/src/coinbase.ts";
import { createGammaClient } from "../../sources/polymarket-markets/src/gamma.ts";
import { transportSnapshot, withTransportMetrics } from "#src/transport-metrics.ts";

test("direct REST adapters measure each attempt without changing rate-limit delays or retry responses", async (t) => {
  const attempts = new Map<string, number>();
  const delays: number[] = [];
  const clock = { now: () => 0, sleep: async (ms: number) => { delays.push(ms); } };
  t.mock.method(globalThis, "fetch", async (input: URL) => {
    const host = input.hostname;
    const attempt = (attempts.get(host) ?? 0) + 1;
    attempts.set(host, attempt);
    if (host === "binance.invalid") return Response.json([], { headers: { "x-mbx-used-weight-1m": "5000" } });
    if (attempt === 1) return Response.json({ message: "retry", error: "retry" }, { status: host === "coinbase.invalid" ? 429 : 503 });
    return Response.json(host === "coinbase.invalid"
      ? { id: "ETH-USD", base_currency: "ETH", quote_currency: "USD", status: "online" }
      : { markets: [{ id: "market-1" }], next_cursor: null });
  });
  await withTransportMetrics(async () => {
    const binance = createBinanceClient("https://binance.invalid", clock);
    assert.deepEqual(await binance.candles({ symbol: "ETHUSDT", interval: "1h", startTime: 0, limit: 1 }), []);
    await binance.waitForWeight();
    const coinbase = createCoinbaseClient("https://coinbase.invalid", clock);
    assert.equal((await coinbase.product("ETH-USD")).id, "ETH-USD");
    await coinbase.waitForRate();
    const gamma = createGammaClient("https://gamma.invalid", clock);
    assert.deepEqual(await gamma.markets({ version: "v1", closed: false, endDateMin: null,
      endDateMax: null, limit: 1, afterCursor: undefined }), { markets: [{ id: "market-1" }], nextCursor: undefined });
    assert.deepEqual(delays, [60_000, 1000, 1000, 1000]);
    const snapshot = transportSnapshot();
    assert.equal(snapshot.requestsStarted, 5);
    assert.equal(snapshot.requestsCompleted, 5);
    assert.equal(snapshot.requestsFailed, 2);
    assert.equal(snapshot.activeRequests, 0);
    assert.equal(snapshot.delayedTasks, 0);
  });
});
