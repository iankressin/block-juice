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
import type { LighterFundingsEnv } from "#src/source.ts";

type Call = Parameters<Awaited<ReturnType<typeof sourceWith>>["extract"]>[1][number];
type Request = { path: string; market_id: number; resolution: string | null; start: number; end: number };

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const HOUR = 3_600_000;
const WINDOW = 750 * HOUR;
// Funding hours sit on the epoch's hour grid, so a start of 0 lines up with every window.
const START = 0;
// The fake serves funding for hours 0 to 1199. Hour 1199 closed 30 minutes ago.
const COUNT = 1200;
const NOW = COUNT * HOUR + HOUR / 2;

const MARKETS = [
  { market_id: 0, symbol: "ETH", market_type: "perp", size_decimals: 4, price_decimals: 2 },
  { market_id: 1, symbol: "BTC", market_type: "perp", size_decimals: 5, price_decimals: 1 },
];
const SPOT = [{ market_id: 2048, symbol: "ETH/USDC", market_type: "spot", size_decimals: 4, price_decimals: 2 }];

type Reply = { status: number; body: unknown };

/** The entry paid at hour `i`, as Lighter sends it. */
const funding = (i: number, over: Record<string, unknown> = {}) => ({
  timestamp: i * 3600,
  value: `0.0${i}`,
  rate: "0.0005",
  direction: i % 2 === 0 ? "long" : "short",
  ...over,
});

/**
 * Lighter's orderBookDetails and fundings. Each market has 1,200 hourly entries, and like Lighter
 * a range holding more than 750 gets only its newest 750. `entry` changes an entry of the reply.
 * `requests` gets each fundings request.
 */
async function fakeLighter(
  t: TestContext,
  {
    reply,
    entry = funding,
    requests = [],
  }: {
    reply?: (query: URLSearchParams) => Reply | undefined;
    entry?: (i: number) => Record<string, unknown>;
    requests?: Request[];
  } = {},
) {
  const server = createServer((req, res) => {
    const { pathname, searchParams: query } = new URL(req.url!, "http://lighter");
    let answer: Reply;
    if (pathname === "/api/v1/orderBookDetails") {
      answer = { status: 200, body: { code: 200, order_book_details: MARKETS, spot_order_book_details: SPOT } };
    } else {
      const start = Number(query.get("start_timestamp"));
      const end = Number(query.get("end_timestamp"));
      requests.push({ path: pathname, market_id: Number(query.get("market_id")), resolution: query.get("resolution"), start, end });
      const inRange = Array.from({ length: COUNT }, (_, i) => entry(i)).filter((f) => {
        const ms = (f.timestamp as number) * 1000;
        return ms >= start && ms <= end;
      });
      answer = reply?.(query) ?? { status: 200, body: { code: 200, fundings: inRange.slice(-750) } };
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
  const dir = await mkdtemp(join(tmpdir(), "lighter-fundings-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "markets.json"), typeof markets === "string" ? markets : JSON.stringify(markets));
  const copy: typeof import("#src/source.ts") = await import(pathToFileURL(join(dir, "src", "source.ts")).href);
  return copy.fundingsSource(clock);
}

const envAt = (url: string): LighterFundingsEnv => ({
  LIGHTER_API_URL: url,
  LIGHTER_REQUESTS_PER_MINUTE: 60,
  START_TIME: START,
});

async function run(
  source: Awaited<ReturnType<typeof sourceWith>>,
  env: LighterFundingsEnv,
  retry: Call[] = [],
  context?: ExtractionContext<Call>,
) {
  const batches: Batch<Call>[] = [];
  for await (const batch of source.extract(env, retry, context)) batches.push(batch);
  return batches;
}

const both = { markets: ["ETH", "BTC"] };

const call = (market_id: number, symbol: string, start: number): Call => ({
  market_id,
  symbol,
  start_time: start,
  end_time: start + WINDOW - 1,
});

test("loads every market's funding in windows of 750 hours that meet with no gap", async (t) => {
  const requests: Request[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, both);

  const batches = await run(source, envAt(url));

  for (const r of requests) {
    assert.equal(r.path, "/api/v1/fundings");
    assert.equal(r.resolution, "1h");
    assert.ok((r.end - r.start + 1) / HOUR <= 750, `${r.start}-${r.end} spans more than 750 hours`);
  }
  const expected = [
    [0, 750 * HOUR - 1],
    [750 * HOUR, 1500 * HOUR - 1],
  ];
  assert.deepEqual(requests.filter((r) => r.market_id === 0).map((r) => [r.start, r.end]), expected);
  assert.deepEqual(requests.filter((r) => r.market_id === 1).map((r) => [r.start, r.end]), expected);

  const records = batches.flatMap((batch) => batch.records);
  for (const market_id of [0, 1]) {
    const ids = records.filter((r) => r.data.market_id === market_id).map((r) => r.id);
    assert.deepEqual(ids, Array.from({ length: COUNT }, (_, i) => `${market_id}:${i * 3600}`));
  }
  assert.deepEqual(batches.flatMap((batch) => batch.failed), []);
  // One window a batch, so a checkpoint commits after each.
  assert.equal(batches.length, 4);
});

test("a record holds the entry as Lighter sent it, under its call", async (t) => {
  const url = await fakeLighter(t);
  const source = await sourceWith(t, { markets: ["ETH"] });

  const records = (await run(source, envAt(url))).flatMap((batch) => batch.records);

  assert.deepEqual(records.find((r) => r.id === `0:${800 * 3600}`), {
    id: `0:${800 * 3600}`,
    callId: `0:${WINDOW}`,
    data: { market_id: 0, symbol: "ETH", funding: funding(800) },
  });
});

test("an entry stamped after the request time waits for the next run", async (t) => {
  // At 1000:30 the hour 1000 payment is out. Lighter has no later entry yet; the fake sends them anyway.
  const url = await fakeLighter(t);
  const source = await sourceWith(t, { markets: ["ETH"] }, fakeClock(1000 * HOUR + HOUR / 2));

  const ids = (await run(source, envAt(url))).flatMap((batch) => batch.records).map((r) => r.id);

  assert.equal(ids.length, 1001);
  assert.ok(ids.includes(`0:${1000 * 3600}`));
  assert.ok(!ids.includes(`0:${1001 * 3600}`));
});

test("an entry stamped exactly at the request time loads", async (t) => {
  const url = await fakeLighter(t);
  const source = await sourceWith(t, { markets: ["ETH"] }, fakeClock(1000 * HOUR));

  const ids = (await run(source, envAt(url))).flatMap((batch) => batch.records).map((r) => r.id);

  assert.ok(ids.includes(`0:${1000 * 3600}`));
  assert.ok(!ids.includes(`0:${1001 * 3600}`));
});

test("a zero rate loads, whatever the hour", async (t) => {
  const entry = (i: number) => (i === 600 ? funding(i, { rate: "0.0000" }) : funding(i));
  const url = await fakeLighter(t, { entry });
  const source = await sourceWith(t, { markets: ["ETH"] }, fakeClock(1199 * HOUR + HOUR / 2));

  const records = (await run(source, envAt(url))).flatMap((batch) => batch.records);

  const zero = records.find((r) => r.id === `0:${600 * 3600}`);
  assert.equal((zero!.data.funding as { rate: string }).rate, "0.0000");
  assert.ok(records.some((r) => r.id === `0:${1199 * 3600}`));
});

test("an hour mark that passes while the reply is on its way waits for the next run", async (t) => {
  let now = 1199 * HOUR + HOUR / 2;
  const clock: Clock = { now: () => now, sleep: async (ms) => void (now += ms) };
  const url = await fakeLighter(t, {
    reply: (query) => {
      // The last window goes out before hour 1200, and the clock passes its mark as Lighter answers with its entry.
      if (Number(query.get("start_timestamp")) !== 750 * HOUR) return undefined;
      now = 1200 * HOUR + 60_000;
      return { status: 200, body: { code: 200, fundings: [funding(1199), funding(1200)] } };
    },
  });
  const source = await sourceWith(t, { markets: ["ETH"] }, clock);

  const records = (await run(source, envAt(url))).flatMap((batch) => batch.records);

  assert.ok(records.some((r) => r.id === `0:${1199 * 3600}`));
  assert.ok(!records.some((r) => r.id === `0:${1200 * 3600}`));
});

test("an entry Lighter sends from outside its window is dropped", async (t) => {
  const url = await fakeLighter(t, {
    reply: (query) =>
      Number(query.get("start_timestamp")) === 0
        ? { status: 200, body: { code: 200, fundings: [funding(-1), funding(0), funding(750)] } }
        : undefined,
  });
  const source = await sourceWith(t, { markets: ["ETH"] });

  const records = (await run(source, envAt(url))).flatMap((batch) => batch.records);

  assert.deepEqual(records.filter((r) => r.callId === "0:0").map((r) => r.id), ["0:0"]);
});

test("markets.json with an unknown symbol fails the run, naming it", async (t) => {
  const url = await fakeLighter(t);
  const source = await sourceWith(t, { markets: ["ETH", "DOGE2"] });
  await assert.rejects(run(source, envAt(url)), /DOGE2/);
});

test("markets.json with a spot market fails the run, naming it", async (t) => {
  const requests: Request[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH", "ETH/USDC"] });
  await assert.rejects(
    run(source, envAt(url)),
    /markets\.json lists ETH\/USDC, a spot market; fundings exist only for perp markets/,
  );
  assert.equal(requests.length, 0);
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
  const requests: Request[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH", "ETH"] });

  await run(source, envAt(url));

  assert.equal(requests.length, 2);
});

test("a failed window waits as a dead letter, and the other windows load", async (t) => {
  const url = await fakeLighter(t, {
    reply: (query) =>
      Number(query.get("start_timestamp")) === WINDOW ? { status: 400, body: { code: 20001, message: "invalid param" } } : undefined,
  });
  const source = await sourceWith(t, { markets: ["ETH"] });

  const batches = await run(source, envAt(url));

  assert.deepEqual(batches.flatMap((batch) => batch.failed), [
    {
      id: `0:${WINDOW}`,
      call: call(0, "ETH", WINDOW),
      error: "Lighter answered HTTP 400 (code 20001): invalid param",
    },
  ]);
  assert.equal(batches.flatMap((batch) => batch.records).length, 750);
});

test("a retried call is made again, and a call the run makes anyway is made once", async (t) => {
  const requests: Request[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH"] });
  // BTC left markets.json after its window failed; ETH's window is among the run's own.
  const btc = call(1, "BTC", 0);
  const eth = call(0, "ETH", WINDOW);

  const batches = await run(source, envAt(url), [btc, eth]);

  assert.equal(requests.filter((r) => r.market_id === 1).length, 1);
  assert.equal(requests.filter((r) => r.market_id === 0 && r.start === WINDOW).length, 1);
  assert.equal(batches.flatMap((batch) => batch.records).filter((r) => r.data.market_id === 1).length, 750);
});

test("committed history resumes, and a routine run reads only the recent windows", async (t) => {
  const requests: Request[] = [];
  const url = await fakeLighter(t, { requests });
  const source = await sourceWith(t, { markets: ["ETH"] });
  const key = (await import("@ingestion/lib")).historyKey(["lighter", "fundings", url, 0, "ETH", START]);
  const saved = (next: number) => ({
    getCheckpoint: async (k: string) => (k === key ? { origin: 0, next, refreshedAt: NOW } : undefined),
  });

  // Windows 0 and 1 committed: the run resumes at window 1, the last one attempted, which may have held entries not yet paid.
  const batches = await run(source, envAt(url), [], saved(2 * WINDOW));
  assert.deepEqual(requests.map((r) => r.start), [WINDOW]);
  const checkpoints = batches.flatMap((batch) => batch.checkpoints ?? []).filter((c) => c.key === key);
  assert.deepEqual(checkpoints.map((c) => (c.value as { next: number }).next), [2 * WINDOW]);
});
