import assert from "node:assert/strict";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { historyKey, type Batch, type Checkpoint } from "@ingestion/lib";
import type { Clock } from "@ingestion/lib";
import { fakeBucket, parquetFile, type FakeBucket } from "@ingestion/lib/lighter/s3-fixture";
import { tradesEnv } from "#src/source.ts";

type Source = Awaited<ReturnType<typeof sourceWith>>;
type Call = Parameters<Source["extract"]>[1][number];

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const PREFIX = "v1.1/lighter/core/mainnet";

/** A trade row, cut to the columns these tests read. `slot` is S3's market_id, `market` its public_market_index. */
type Trade = { id: number; ask: number; bid: number; slot: number; market: number | null };

const trade = (id: number, ask: number, bid: number, slot = 0, market: number | null = slot): Trade => ({ id, ask, bid, slot, market });

/**
 * A Parquet file of one day's trades, with the file's column types. The other values are those of
 * trade 40627877458: 0.3491 ETH at 1819.52, sold by its maker (catalog/vendors/lighter/NOTES.md, Units).
 */
async function dayFile(t: TestContext, date: string, trades: Trade[]): Promise<Buffer> {
  const rows = trades.map(
    (r) =>
      `(${r.id}, '${date} 00:36:33.323525+00', ${r.ask}, ${r.bid}, 3491, 181952, 635194432, 1794789393275, ` +
      `${r.slot}, 'trade', true, 50, 0, -2252, null, ${r.market ?? "null"})`,
  );
  return parquetFile(
    t,
    `select id::bigint as id, created_at::varchar as created_at, ask_account_id::bigint as ask_account_id,
      bid_account_id::bigint as bid_account_id, size::bigint as size, price::bigint as price,
      usdc_amount::bigint as usdc_amount, "timestamp"::bigint as "timestamp", market_id::smallint as market_id,
      trade_type::varchar as trade_type, is_maker_ask::boolean as is_maker_ask, maker_fee::integer as maker_fee,
      taker_fee::integer as taker_fee, maker_position_size_before::bigint as maker_position_size_before,
      ask_account_pnl::bigint as ask_account_pnl, public_market_index::bigint as public_market_index
    from (values ${rows.join(", ")}) t(id, created_at, ask_account_id, bid_account_id, size, price, usdc_amount,
      "timestamp", market_id, trade_type, is_maker_ask, maker_fee, taker_fee, maker_position_size_before,
      ask_account_pnl, public_market_index)`,
  );
}

// ETH is public 0. In S3, slot 51 held RESOLV (public 51) before 2026-08-20 and PRL (public 4097) on
// 2026-11-16 (NOTES.md, Market identity).
const MARKETS = [
  { market_id: 0, symbol: "ETH", market_type: "perp", size_decimals: 4, price_decimals: 2 },
  { market_id: 51, symbol: "RESOLV", market_type: "perp", size_decimals: 0, price_decimals: 6 },
  { market_id: 4097, symbol: "PRL", market_type: "perp", size_decimals: 2, price_decimals: 4 },
];

type Fake = FakeBucket & {
  url: string;
  apiUrl: string;
  /** How many times the source read orderBookDetails. */
  marketReads: number;
};

/** Lighter's S3 bucket of trade files, and its orderBookDetails on a server of its own. */
async function fakeLighter(t: TestContext, days: Record<string, Trade[]>): Promise<Fake> {
  const files: Record<string, Buffer> = {};
  for (const [date, trades] of Object.entries(days)) files[date] = await dayFile(t, date, trades);
  const bucket = await fakeBucket(t, "trades", files);
  const fake: Fake = Object.assign(bucket, { url: bucket.env.LIGHTER_S3_URL, apiUrl: "", marketReads: 0 });
  const server = createServer((req, res) => {
    if (new URL(req.url!, "http://lighter").pathname !== "/api/v1/orderBookDetails") {
      res.writeHead(404).end();
      return;
    }
    fake.marketReads++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: 200, order_book_details: MARKETS, spot_order_book_details: [] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  fake.apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

const fakeClock = (iso = "2026-11-17T08:00:00Z"): Clock => ({ now: () => Date.parse(iso), sleep: async () => {} });

/** This package's source from a copy whose addresses.json holds `addresses`. */
async function sourceWith(t: TestContext, addresses: unknown, clock: Clock = fakeClock()) {
  const dir = await mkdtemp(join(tmpdir(), "lighter-trades-"));
  t.after(() => rm(dir, { recursive: true }));
  await cp(join(packageDir, "src"), join(dir, "src"), { recursive: true });
  await cp(join(packageDir, "package.json"), join(dir, "package.json"));
  await symlink(join(packageDir, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "addresses.json"), typeof addresses === "string" ? addresses : JSON.stringify(addresses));
  const copy: typeof import("#src/source.ts") = await import(pathToFileURL(join(dir, "src", "source.ts")).href);
  return copy.tradesSource(clock);
}

type Saved = Record<string, unknown>;

async function run(source: Source, fake: Fake, { start = "2026-11-15", saved = {} }: { start?: string; saved?: Saved } = {}) {
  const env = tradesEnv.parse({
    LIGHTER_API_URL: fake.apiUrl,
    LIGHTER_REQUESTS_PER_MINUTE: "60",
    LIGHTER_S3_URL: fake.url,
    LIGHTER_S3_PREFIX: PREFIX,
    START_DATE: start,
    END_DATE: "2026-11-16",
  });
  const batches: Batch<Call>[] = [];
  for await (const batch of source.extract(env, [], { getCheckpoint: async (key) => saved[key] })) batches.push(batch);
  return batches;
}

const recordsOf = (batches: Batch<Call>[]) => batches.flatMap((b) => b.records);
const checkpointOf = (batches: Batch<Call>[]): Checkpoint => batches.flatMap((b) => b.checkpoints ?? []).at(-1)!;
const asSaved = (checkpoint: Checkpoint): Saved => ({ [checkpoint.key]: checkpoint.value });
const KEY = (url: string, accounts?: number[], markets?: number[]) =>
  historyKey(["lighter", url, PREFIX, "trades", accounts, markets]);

const ACCOUNT = 313004;
// 40627877458 and 40627877460 are the account's; 40627877459 and 40627877461 are not.
const TWO_DAYS = {
  "2026-11-15": [trade(40627877458, 757337, ACCOUNT), trade(40627877459, 1, 2)],
  "2026-11-16": [trade(40627877460, ACCOUNT, 3), trade(40627877461, 4, 5)],
};

test("neither accounts nor markets fails the run", async (t) => {
  const fake = await fakeLighter(t, TWO_DAYS);
  const source = await sourceWith(t, {});
  await assert.rejects(run(source, fake), {
    message: "addresses.json lists no accounts and no markets. List at least one: one day of Lighter trades is 2 to 8 million rows.",
  });
  assert.equal(fake.marketReads, 0);
  assert.deepEqual(fake.downloads, []);
});

test("an empty or malformed list fails the run, naming the key", async (t) => {
  const fake = await fakeLighter(t, TWO_DAYS);
  const cases: [unknown, RegExp][] = [
    [{ accounts: [] }, /accounts/],
    [{ accounts: ["x"] }, /accounts/],
    [{ accounts: [-1] }, /accounts/],
    [{ accounts: [1.5] }, /accounts/],
    [{ accounts: [2 ** 53] }, /accounts/],
    [{ accounts: null }, /accounts/],
    [{ markets: [] }, /markets/],
    [{ markets: [""] }, /markets/],
    [{ markets: "ETH" }, /markets/],
    [{ account: [ACCOUNT] }, /account/],
  ];
  for (const [addresses, names] of cases) {
    const source = await sourceWith(t, addresses);
    await assert.rejects(run(source, fake), names, JSON.stringify(addresses));
  }
  assert.equal(fake.marketReads, 0);
  assert.deepEqual(fake.downloads, []);
});

test("malformed addresses.json fails the run, not the import", async (t) => {
  const source = await sourceWith(t, '{ "accounts": , }');
  await assert.rejects(run(source, { url: "http://127.0.0.1:1", apiUrl: "http://127.0.0.1:1" } as Fake), /addresses\.json/);
});

test("loads the listed accounts' trades from each day file, keyed by trade id", async (t) => {
  const fake = await fakeLighter(t, TWO_DAYS);
  const source = await sourceWith(t, { accounts: [ACCOUNT] });

  const batches = await run(source, fake);

  const records = recordsOf(batches);
  assert.deepEqual(records.map((r) => r.id), ["40627877458", "40627877460"]);
  assert.deepEqual(records.map((r) => r.callId), ["trades:2026-11-15#0", "trades:2026-11-16#0"]);
  // As Lighter sent it: 64-bit integers as strings, no unit conversion.
  assert.deepEqual(records[0]!.data, {
    id: "40627877458",
    created_at: "2026-11-15 00:36:33.323525+00",
    ask_account_id: "757337",
    bid_account_id: "313004",
    size: "3491",
    price: "181952",
    usdc_amount: "635194432",
    timestamp: "1794789393275",
    market_id: 0,
    trade_type: "trade",
    is_maker_ask: true,
    maker_fee: 50,
    taker_fee: 0,
    maker_position_size_before: "-2252",
    ask_account_pnl: null,
    public_market_index: "0",
  });
  // Accounts alone need no market, so the run never calls the exchange API.
  assert.equal(fake.marketReads, 0);
  const checkpoint = checkpointOf(batches);
  assert.equal(checkpoint.key, KEY(fake.url, [ACCOUNT]));
  assert.deepEqual(checkpoint.value, { files: { "2026-11-15": "etag-2026-11-15", "2026-11-16": "etag-2026-11-16" } });

  fake.downloads.length = 0;
  assert.deepEqual(await run(source, fake, { saved: asSaved(checkpoint) }), []);
  assert.deepEqual(fake.downloads, []);
});

test("filters markets on the public id, so a reused slot's old market stays out", async (t) => {
  // A: slot 51 trading PRL (public 4097). B: slot 51 before 2026-08-20, so RESOLV with no public id.
  const ids: Record<string, string> = { "1": "A", "2": "B", "3": "C" };
  const fake = await fakeLighter(t, { "2026-11-16": [trade(1, 10, 11, 51, 4097), trade(2, 12, 13, 51, null), trade(3, 14, 15, 0)] });
  const idsFor = async (markets: string[]) =>
    recordsOf(await run(await sourceWith(t, { markets }), fake, { start: "2026-11-16" })).map((r) => ids[r.id]);

  assert.deepEqual(await idsFor(["PRL"]), ["A"]);
  assert.deepEqual(await idsFor(["RESOLV"]), ["B"]);
  assert.deepEqual(await idsFor(["ETH"]), ["C"]);
});

test("with both keys, loads the listed accounts' trades in the listed markets", async (t) => {
  const fake = await fakeLighter(t, {
    "2026-11-16": [trade(1, ACCOUNT, 2), trade(2, 3, ACCOUNT, 51, 4097), trade(3, 4, 5)],
  });
  const source = await sourceWith(t, { accounts: [ACCOUNT], markets: ["ETH"] });

  const batches = await run(source, fake, { start: "2026-11-16" });

  assert.deepEqual(recordsOf(batches).map((r) => r.id), ["1"]);
  assert.equal(fake.marketReads, 1);
  assert.equal(checkpointOf(batches).key, KEY(fake.url, [ACCOUNT], [0]));
});

test("a market symbol Lighter does not list fails the run, naming it", async (t) => {
  const fake = await fakeLighter(t, TWO_DAYS);
  const source = await sourceWith(t, { markets: ["ETH", "NOPE"] });
  await assert.rejects(run(source, fake), /NOPE/);
  assert.deepEqual(fake.downloads, []);
});

test("a changed addresses.json loads every day again under a new manifest", async (t) => {
  const fake = await fakeLighter(t, TWO_DAYS);
  const first = await run(await sourceWith(t, { accounts: [ACCOUNT] }), fake);
  assert.deepEqual(fake.downloads, ["2026-11-15", "2026-11-16"]);

  fake.downloads.length = 0;
  const second = await run(await sourceWith(t, { accounts: [757337, ACCOUNT] }), fake, { saved: asSaved(checkpointOf(first)) });
  assert.deepEqual(fake.downloads, ["2026-11-15", "2026-11-16"]);
  assert.deepEqual(recordsOf(second).map((r) => r.id), ["40627877458", "40627877460"]);
  assert.equal(checkpointOf(second).key, KEY(fake.url, [ACCOUNT, 757337]));
  assert.notEqual(checkpointOf(second).key, checkpointOf(first).key);

  // The same accounts in another order, or listed twice, are the same filter.
  fake.downloads.length = 0;
  const saved = { ...asSaved(checkpointOf(first)), ...asSaved(checkpointOf(second)) };
  assert.deepEqual(await run(await sourceWith(t, { accounts: [ACCOUNT, 757337, ACCOUNT] }), fake, { saved }), []);
  assert.deepEqual(fake.downloads, []);
});

test("END_DATE may not precede START_DATE", () => {
  assert.throws(() => tradesEnv.parse({ START_DATE: "2026-11-14", END_DATE: "2026-11-13" }), /END_DATE may not come before START_DATE/);
  assert.doesNotThrow(() => tradesEnv.parse({ START_DATE: "2026-11-14", END_DATE: "2026-11-14" }));
});
