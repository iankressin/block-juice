import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Batch } from "@ingestion/lib";
import type { Clock } from "@ingestion/lib";
import { lighterEnv } from "@ingestion/lib/lighter";

type Source = Awaited<ReturnType<typeof sourceWith>>;
type Call = Parameters<Source["extract"]>[1][number];

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const DAY = 86_400_000;
// The fake serves days 0 to 9. Day 9 began 6 hours ago, so it has not ended.
const NOW = 9 * DAY + 6 * 3_600_000;

const MARKETS = [{ market_id: 0, symbol: "ETH", market_type: "perp", size_decimals: 4, price_decimals: 2 }];

/** The point of day `i`, as Lighter sends it. */
const point = (i: number) => ({ timestamp: i * 86_400, data: 100 + i });

type Reply = { status: number; body: unknown };

/** Lighter's orderBookDetails and exchangeMetrics. `requests` gets each exchangeMetrics query. */
async function fakeLighter(
  t: TestContext,
  { reply, requests = [] }: { reply?: (query: URLSearchParams) => Reply | undefined; requests?: URLSearchParams[] } = {},
) {
  const server = createServer((req, res) => {
    const { pathname, searchParams: query } = new URL(req.url!, "http://lighter");
    let answer: Reply;
    if (pathname === "/api/v1/orderBookDetails") {
      answer = { status: 200, body: { code: 200, order_book_details: MARKETS, spot_order_book_details: [] } };
    } else {
      requests.push(query);
      answer = reply?.(query) ?? { status: 200, body: { code: 200, metrics: Array.from({ length: 10 }, (_, i) => point(i)) } };
    }
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A clock stopped at `now` that a sleep moves forward at once. */
function fakeClock(now = NOW): Clock {
  return { now: () => now, sleep: async (ms) => void (now += ms) };
}

/** This package's source from a copy whose markets.json holds `markets`. */
async function sourceWith(t: TestContext, markets: unknown, clock: Clock = fakeClock()) {
  const dir = await mkdtemp(join(tmpdir(), "lighter-exchange-metrics-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "markets.json"), typeof markets === "string" ? markets : JSON.stringify(markets));
  const copy: typeof import("#src/source.ts") = await import(pathToFileURL(join(dir, "src", "source.ts")).href);
  return copy.exchangeMetricsSource(clock);
}

async function run(source: Source, url: string, retry: Call[] = []) {
  const env = lighterEnv.parse({ LIGHTER_API_URL: url, LIGHTER_REQUESTS_PER_MINUTE: "60" });
  const batches: Batch<Call>[] = [];
  for await (const batch of source.extract(env, retry)) batches.push(batch);
  return batches;
}

test("reads every kind exchange-wide and the market kinds for each listed market", async (t) => {
  const requests: URLSearchParams[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH"] });

  const batches = await run(source, url);

  assert.equal(requests.length, 18 + 10);
  assert.ok(requests.every((q) => q.get("period") === "all"));
  const wide = requests.filter((q) => !q.has("filter"));
  const byMarket = requests.filter((q) => q.has("filter"));
  assert.equal(wide.length, 18);
  assert.equal(new Set(wide.map((q) => q.get("kind"))).size, 18);
  assert.ok(!wide.some((q) => q.get("kind") === "tps"));
  assert.equal(byMarket.length, 10);
  assert.ok(byMarket.every((q) => q.get("filter") === "byMarket" && q.get("value") === "ETH"));
  assert.deepEqual(
    new Set(byMarket.map((q) => q.get("kind"))),
    new Set([
      "volume", "maker_fee", "taker_fee", "liquidation_fee", "trade_count", "liquidation_count",
      "liquidation_volume", "open_interest", "attribution_maker_fee", "attribution_taker_fee",
    ]),
  );

  const records = batches.flatMap((b) => b.records);
  // Days 0 to 8 have ended; day 9 has not.
  assert.equal(records.length, 28 * 9);
  assert.deepEqual(records.find((r) => r.id === "trade_count:ETH:86400"), {
    id: "trade_count:ETH:86400",
    callId: "trade_count:ETH",
    data: { kind: "trade_count", market: "ETH", point: point(1) },
  });
  assert.ok(records.some((r) => r.id === "trade_count:all:86400" && r.data.market === null));
  assert.deepEqual(batches.flatMap((b) => b.failed), []);
});

test("today's point waits for the next run", async (t) => {
  const url = await fakeLighter(t);
  const source = await sourceWith(t, { markets: [] });

  const records = (await run(source, url)).flatMap((b) => b.records);

  const ids = records.filter((r) => r.data.kind === "volume").map((r) => r.id);
  assert.equal(ids.length, 9);
  assert.ok(!ids.includes(`volume:all:${9 * 86_400}`));
  assert.ok(ids.includes(`volume:all:${8 * 86_400}`));
});

test("a day that ends while the reply is on its way waits too", async (t) => {
  let now = NOW;
  const clock: Clock = { now: () => now, sleep: async (ms) => void (now += ms) };
  const url = await fakeLighter(t, {
    reply: (q) => {
      // The first request goes out on day 9, and the clock passes midnight as Lighter answers.
      if (q.get("kind") === "volume") now = 10 * DAY + 60_000;
      return undefined;
    },
  });
  const source = await sourceWith(t, { markets: [] }, clock);

  const records = (await run(source, url)).flatMap((b) => b.records);

  assert.ok(!records.some((r) => r.id === `volume:all:${9 * 86_400}`));
  assert.ok(records.some((r) => r.id === `volume:all:${8 * 86_400}`));
});

test("a failed kind waits as a dead letter, and the others load", async (t) => {
  const url = await fakeLighter(t, {
    reply: (q) => (q.get("kind") === "inflow" ? { status: 400, body: { code: 20001, message: "invalid param" } } : undefined),
  });
  const source = await sourceWith(t, { markets: [] });

  const batches = await run(source, url);

  assert.deepEqual(batches.flatMap((b) => b.failed), [
    { id: "inflow:all", call: { kind: "inflow", market: null }, error: "Lighter answered HTTP 400 (code 20001): invalid param" },
  ]);
  assert.equal(batches.flatMap((b) => b.records).length, 17 * 9);
});

test("every call that succeeds is named, so a retried call with no points clears its dead letter", async (t) => {
  const url = await fakeLighter(t, {
    reply: (q) => (q.get("kind") === "inflow" ? { status: 200, body: { code: 200, metrics: [] } } : undefined),
  });
  const source = await sourceWith(t, { markets: [] });

  const batches = await run(source, url, [{ kind: "inflow", market: null }]);

  const succeeded = batches.flatMap((b) => b.succeededCallIds ?? []);
  assert.equal(succeeded.length, 18);
  assert.ok(succeeded.includes("inflow:all"));
  assert.equal(batches.flatMap((b) => b.failed).length, 0);
});

test("a retried call is made again, and a call the run makes anyway is made once", async (t) => {
  const requests: URLSearchParams[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: [] });

  const batches = await run(source, url, [
    { kind: "volume", market: "BTC" },
    { kind: "inflow", market: null },
  ]);

  assert.equal(requests.length, 18 + 1);
  assert.equal(requests.filter((q) => q.get("kind") === "inflow").length, 1);
  assert.equal(requests.filter((q) => q.get("value") === "BTC").length, 1);
  assert.equal(batches.flatMap((b) => b.records).filter((r) => r.data.market === "BTC").length, 9);
});

test("markets.json with an unknown symbol fails the run, naming it", async (t) => {
  const requests: URLSearchParams[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH", "DOGE2"] });
  await assert.rejects(run(source, url), /DOGE2/);
  assert.equal(requests.length, 0);
});

test("malformed markets.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, '{ "markets": , }');
  await assert.rejects(run(source, "http://127.0.0.1:1"), /markets\.json/);
});
