import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Batch, ExtractionContext } from "@ingestion/lib";
import type { Clock } from "@ingestion/lib/lighter";
import type { LighterCandlesEnv } from "#src/source.ts";

type Call = Parameters<Awaited<ReturnType<typeof sourceWith>>["extract"]>[1][number];

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const HOUR = 3_600_000;
const WINDOW = 500 * HOUR;
// Lighter's bucket grid is the epoch's, so a start of 0 lines up with every window.
const START = 0;
// The fake serves candles for hours 0 to 1199. Hour 1199 closed 30 minutes ago.
const COUNT = 1200;
const NOW = COUNT * HOUR + HOUR / 2;

const MARKETS = [
  { market_id: 0, symbol: "ETH", market_type: "perp", size_decimals: 4, price_decimals: 2 },
  { market_id: 1, symbol: "BTC", market_type: "perp", size_decimals: 5, price_decimals: 1 },
];

type Reply = { status: number; body: unknown };

const tradeCandle = (t: number, i: number) => ({ t, o: i + 0.1, h: i + 0.2, l: i + 0.3, c: i + 0.4, v: i + 0.5, V: i + 0.6, i: i + 7 });
const markCandle = (t: number, i: number) => ({ t, o: i + 0.1, h: i + 0.2, l: i + 0.3, c: i + 0.4, sc: i + 9 });

/**
 * Lighter's orderBookDetails, candles and markPriceCandles. Each market and price has 1,200
 * hourly candles, and like Lighter a range holding more than 500 gets only its newest 500.
 * `requests` gets each candles request as `{ path, market_id, start, end }`.
 */
async function fakeLighter(
  t: TestContext,
  {
    reply,
    requests = [],
  }: {
    reply?: (path: string, query: URLSearchParams) => Reply | undefined;
    requests?: { path: string; market_id: number; start: number; end: number }[];
  } = {},
) {
  const server = createServer((req, res) => {
    const { pathname, searchParams: query } = new URL(req.url!, "http://lighter");
    let answer: Reply;
    if (pathname === "/api/v1/orderBookDetails") {
      answer = { status: 200, body: { code: 200, order_book_details: MARKETS, spot_order_book_details: [] } };
    } else {
      const marketId = Number(query.get("market_id"));
      const start = Number(query.get("start_timestamp"));
      const end = Number(query.get("end_timestamp"));
      requests.push({ path: pathname, market_id: marketId, start, end });
      const make = pathname === "/api/v1/candles" ? tradeCandle : markCandle;
      const inRange = Array.from({ length: COUNT }, (_, i) => make(i * HOUR, i)).filter(
        (candle) => candle.t >= start && candle.t <= end,
      );
      answer = reply?.(pathname, query) ?? { status: 200, body: { code: 200, r: "1h", c: inRange.slice(-500) } };
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
  return {
    now: () => now,
    sleep: async (ms) => void (now += ms),
  };
}

/** This package's source from a copy whose markets.json holds `markets`. */
async function sourceWith(t: TestContext, markets: unknown, clock: Clock = fakeClock()) {
  const dir = await mkdtemp(join(tmpdir(), "lighter-candles-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "markets.json"), typeof markets === "string" ? markets : JSON.stringify(markets));
  const copy: typeof import("#src/source.ts") = await import(pathToFileURL(join(dir, "src", "source.ts")).href);
  return copy.candlesSource(clock);
}

const envAt = (url: string): LighterCandlesEnv => ({
  LIGHTER_API_URL: url,
  LIGHTER_REQUESTS_PER_MINUTE: 60,
  CANDLE_RESOLUTION: "1h",
  START_TIME: START,
});

async function run(
  source: Awaited<ReturnType<typeof sourceWith>>,
  env: LighterCandlesEnv,
  retry: Call[] = [],
  context?: ExtractionContext<Call>,
) {
  const batches: Batch<Call>[] = [];
  for await (const batch of source.extract(env, retry, context)) batches.push(batch);
  return batches;
}

const both = { markets: ["ETH", "BTC"] };

const call = (market_id: number, symbol: string, price: "trade" | "mark", start: number): Call => ({
  market_id,
  symbol,
  price,
  resolution: "1h",
  start_time: start,
  end_time: start + WINDOW - 1,
});

test("loads trade and mark candles in windows of 500 that meet with no gap", async (t) => {
  const requests: { path: string; market_id: number; start: number; end: number }[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, both);

  const batches = await run(source, envAt(url));

  for (const r of requests) assert.ok((r.end - r.start + 1) / HOUR <= 500, `${r.start}-${r.end} spans more than 500 buckets`);
  const windowsOf = (market_id: number, path: string) =>
    requests.filter((r) => r.market_id === market_id && r.path === path).map((r) => [r.start, r.end]);
  const expected = [
    [0, 500 * HOUR - 1],
    [500 * HOUR, 1000 * HOUR - 1],
    [1000 * HOUR, 1500 * HOUR - 1],
  ];
  assert.deepEqual(windowsOf(0, "/api/v1/candles"), expected);
  assert.deepEqual(windowsOf(0, "/api/v1/markPriceCandles"), expected);
  assert.deepEqual(windowsOf(1, "/api/v1/candles"), expected);
  assert.deepEqual(windowsOf(1, "/api/v1/markPriceCandles"), expected);

  const records = batches.flatMap((batch) => batch.records);
  for (const market_id of [0, 1]) {
    for (const price of ["trade", "mark"]) {
      const ids = records.filter((r) => r.data.market_id === market_id && r.data.price === price).map((r) => r.id);
      assert.deepEqual(ids, Array.from({ length: COUNT }, (_, i) => `${market_id}:${price}:1h:${i * HOUR}`));
    }
  }
  assert.equal(records.filter((r) => r.data.price === "mark").length, 2 * COUNT);
  assert.deepEqual(batches.flatMap((batch) => batch.failed), []);
  // One window a batch, so a checkpoint commits after each.
  assert.equal(batches.length, 12);
});

test("a record holds the candle as Lighter sent it, under its call", async (t) => {
  const url = await fakeLighter(t);
  const source = await sourceWith(t, { markets: ["ETH"] });

  const records = (await run(source, envAt(url))).flatMap((batch) => batch.records);

  const trade = records.find((r) => r.id === `0:trade:1h:${600 * HOUR}`);
  assert.deepEqual(trade, {
    id: `0:trade:1h:${600 * HOUR}`,
    callId: `0:trade:1h:${WINDOW}`,
    data: { market_id: 0, symbol: "ETH", price: "trade", resolution: "1h", candle: tradeCandle(600 * HOUR, 600) },
  });
  const mark = records.find((r) => r.id === `0:mark:1h:${3 * HOUR}`);
  assert.deepEqual(mark!.data.candle, markCandle(3 * HOUR, 3));
});

test("a candle still open at the request waits for the next run", async (t) => {
  const url = await fakeLighter(t);
  // Hour 1199 opened 30 minutes ago and is still open.
  const source = await sourceWith(t, { markets: ["ETH"] }, fakeClock(1199 * HOUR + HOUR / 2));

  const records = (await run(source, envAt(url))).flatMap((batch) => batch.records);

  for (const price of ["trade", "mark"]) {
    const ids = records.filter((r) => r.data.price === price).map((r) => r.id);
    assert.equal(ids.length, 1199);
    assert.ok(!ids.includes(`0:${price}:1h:${1199 * HOUR}`));
  }
});

test("a candle that closes while the reply is on its way waits too", async (t) => {
  let now = 1199 * HOUR + HOUR / 2;
  const clock: Clock = { now: () => now, sleep: async (ms) => void (now += ms) };
  const url = await fakeLighter(t, {
    reply: (path, query) => {
      // The last trade window goes out with hour 1199 open, and the clock passes its close as Lighter answers.
      if (path === "/api/v1/candles" && Number(query.get("start_timestamp")) === 1000 * HOUR) now = 1200 * HOUR + 60_000;
      return undefined;
    },
  });
  const source = await sourceWith(t, { markets: ["ETH"] }, clock);

  const records = (await run(source, envAt(url))).flatMap((batch) => batch.records);

  assert.ok(!records.some((r) => r.id === `0:trade:1h:${1199 * HOUR}`));
  assert.equal(records.filter((r) => r.data.price === "trade").length, 1199);
});

test("a candle Lighter sends from outside its window is dropped", async (t) => {
  const url = await fakeLighter(t, {
    reply: (path, query) =>
      path === "/api/v1/candles" && Number(query.get("start_timestamp")) === 0
        ? { status: 200, body: { code: 200, c: [tradeCandle(-HOUR, 0), tradeCandle(0, 1), tradeCandle(500 * HOUR, 2)] } }
        : undefined,
  });
  const source = await sourceWith(t, { markets: ["ETH"] });

  const records = (await run(source, envAt(url))).flatMap((batch) => batch.records);

  assert.deepEqual(
    records.filter((r) => r.callId === "0:trade:1h:0").map((r) => r.id),
    ["0:trade:1h:0"],
  );
});

test("markets.json with an unknown symbol fails the run, naming it", async (t) => {
  const url = await fakeLighter(t);
  const source = await sourceWith(t, { markets: ["ETH", "DOGE2"] });
  await assert.rejects(run(source, envAt(url)), /DOGE2/);
});

test("an empty markets list fails the run", async (t) => {
  const source = await sourceWith(t, { markets: [] });
  await assert.rejects(run(source, envAt("http://127.0.0.1:1")), /markets\.json lists no markets/);
});

test("malformed markets.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, '{ "markets": , }');
  await assert.rejects(run(source, envAt("http://127.0.0.1:1")), /markets\.json/);
});

test("a symbol listed twice is read once", async (t) => {
  const requests: { path: string; market_id: number; start: number; end: number }[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH", "ETH"] });

  await run(source, envAt(url));

  assert.equal(requests.filter((r) => r.path === "/api/v1/candles").length, 3);
});

test("a failed window waits as a dead letter, and the other windows load", async (t) => {
  const url = await fakeLighter(t, {
    reply: (path, query) =>
      path === "/api/v1/markPriceCandles" && Number(query.get("start_timestamp")) === WINDOW
        ? { status: 400, body: { code: 20001, message: "invalid param" } }
        : undefined,
  });
  const source = await sourceWith(t, { markets: ["ETH"] });

  const batches = await run(source, envAt(url));

  assert.deepEqual(batches.flatMap((batch) => batch.failed), [
    {
      id: `0:mark:1h:${WINDOW}`,
      call: call(0, "ETH", "mark", WINDOW),
      error: "Lighter answered HTTP 400 (code 20001): invalid param",
    },
  ]);
  const records = batches.flatMap((batch) => batch.records);
  assert.equal(records.filter((r) => r.data.price === "trade").length, COUNT);
  assert.equal(records.filter((r) => r.data.price === "mark").length, COUNT - 500);
});

test("a retried call is made again, and a call the run makes anyway is made once", async (t) => {
  const requests: { path: string; market_id: number; start: number; end: number }[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH"] });
  // BTC left markets.json after its window failed; ETH's window is among the run's own.
  const btc = call(1, "BTC", "trade", 0);
  const eth = call(0, "ETH", "trade", WINDOW);

  const batches = await run(source, envAt(url), [btc, eth]);

  assert.equal(requests.filter((r) => r.market_id === 1).length, 1);
  assert.equal(requests.filter((r) => r.market_id === 0 && r.path === "/api/v1/candles" && r.start === WINDOW).length, 1);
  const records = batches.flatMap((batch) => batch.records);
  assert.equal(records.filter((r) => r.data.market_id === 1).length, 500);
});

test("committed history resumes, and a routine run reads only the recent windows", async (t) => {
  const requests: { path: string; market_id: number; start: number; end: number }[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH"] });
  const key = (await import("@ingestion/lib")).historyKey(["lighter", url, "ETH", "trade", "1h", START]);
  const saved = (next: number) => ({
    getCheckpoint: async (k: string) => (k === key ? { origin: 0, next, refreshedAt: NOW } : undefined),
  });

  // Windows 0 and 1 committed: the run resumes at window 1, the last one attempted, which may
  // have held an open candle.
  let batches = await run(source, envAt(url), [], saved(1000 * HOUR));
  assert.deepEqual(
    requests.filter((r) => r.path === "/api/v1/candles").map((r) => r.start),
    [500 * HOUR, 1000 * HOUR],
  );
  const checkpoints = batches.flatMap((batch) => batch.checkpoints ?? []).filter((c) => c.key === key);
  assert.deepEqual(
    checkpoints.map((c) => (c.value as { next: number }).next),
    [1000 * HOUR, 1500 * HOUR],
  );

  // Everything committed: only the last window and the overlap it falls in.
  requests.length = 0;
  batches = await run(source, envAt(url), [], saved(1500 * HOUR));
  assert.deepEqual(
    requests.filter((r) => r.path === "/api/v1/candles").map((r) => r.start),
    [1000 * HOUR],
  );
});
