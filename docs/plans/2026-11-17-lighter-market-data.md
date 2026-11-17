# Lighter market data: implementation plan (plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `.claude/skills/blockjuice/references/layers.md` and the Add a source section of `docs/architecture.md` before any task.

**Goal:** Load Lighter's public market data (markets, trades, candles, funding, open interest and exchange-wide daily metrics) into the warehouse and build a `lighter` pipeline of marts on it.

**Architecture:** Lighter is a ZK rollup on Ethereum, but it has no RPC: its data comes from a REST API and a public S3 dataset. Six call sources load it raw, four from the exchange API and two from daily Parquet files on S3. They share a client in a new `@ingestion/lib/lighter` subpath, which paces requests under Lighter's limit and reads Parquet with DuckDB. dbt casts each raw table in staging and applies the unit and market-identity rules in intermediate models. Seven marts come out of it, the account-fill mart giving each account's position after every fill.

**Tech Stack:** TypeScript on `@ingestion/lib` (Node 24, zod 4), `@duckdb/node-api` 1.5.6-r.2 for Parquet, dbt on Postgres, Dagster through `PIPELINES`.

**Spec:** the user's request of 2026-11-17 ("implement support for lighter ethereum l2 … support for all the read methods and create marts that make sense to the API and the chain design") and their answers the same day: load data reads only, public endpoints first, several plans with this one first. *What we know* below holds the rest. Each fact there was read from a live reply on 2026-11-17.

## What we know

**Hosts and limits.**

| Host | Use | Limit |
|---|---|---|
| `https://mainnet.zklighter.elliot.ai/api/v1/` | exchange API | 60 requests a minute per IP for a standard (unauthenticated) caller. Only endpoints weighing over 400 get fewer; every endpoint this plan calls weighs 300. Over the limit: HTTP 429 or 405, and a 60 s cooldown. |
| `https://explorer.elliot.ai/api/` | Explorer (plan 2) | 45 weight a minute; account logs weigh 4 |
| `https://aws-public-blockchain.s3.amazonaws.com/v1.1/lighter/core/mainnet/` | S3 dataset | none; anonymous HTTPS GET and ListObjectsV2 work |

Errors come back as HTTP 400 with `{"code":20001,"message":"invalid param : …"}`. A success carries `"code":200` in the body. Retired paths (`/blocks`, `/txs`, `/accountTxs`, `/currentHeight`) and `/status` answer 403 from CloudFront.

**Endpoints this plan reads.**

| Endpoint | Returns | Traps |
|---|---|---|
| `GET /api/v1/orderBookDetails` | `order_book_details` (perp) and `spot_order_book_details`: 256 markets, each with `market_id`, `symbol`, `size_decimals`, `price_decimals`, `supported_quote_decimals` (6), fees in percent, margin fractions, status, `created_at` (ms) | Binary-option markets are not in it |
| `GET /api/v1/candles` | `{"r","c":[{t,o,h,l,c,v,V,i}]}`, `t` in ms | At most 500 a call; a longer range returns the **newest** 500 and drops the oldest silently. The still-open candle is included. Zero fields are left out. |
| `GET /api/v1/markPriceCandles` | `{t,o,h,l,c,sc}`, with no volume | Same 500 newest, open candle included |
| `GET /api/v1/fundings` | `{timestamp (s), value, rate, direction}` | At most 750 a call; a longer range returns the newest 750, as above. The current hour comes back with `value` and `rate` 0. |
| `GET /api/v1/exchangeMetrics?period=all&kind=K[&filter=byMarket&value=SYMBOL]` | one point a UTC day since 2025-01-17 (669 points), `timestamp` in s | `byMarket` works for 10 kinds and is ignored for 8 (list below); `tps` uses 5-minute points in ms |

`exchangeMetrics` kinds that honour `byMarket`: `volume`, `maker_fee`, `taker_fee`, `liquidation_fee`, `trade_count`, `liquidation_count`, `liquidation_volume`, `open_interest`, `attribution_maker_fee`, `attribution_taker_fee`. Kinds that return the exchange-wide series whatever the filter: `account_count`, `active_account_count`, `inflow`, `outflow`, `transfer_fee`, `withdraw_fee`, `buyback` (since 2025-12-30), `buyback_usdc`.

**S3 dataset.** `trades/date=YYYY-MM-DD/trades.parquet` and `open_interest_hourly/date=YYYY-MM-DD/oi.parquet`, one file per UTC day since 2025-01-17. A day's file appears at about 07:03 UTC the next day. Files use ZSTD and hold up to 1M rows per row group; no row group can be skipped by account or market.

- Trades: 44 columns, integers scaled (see units). 2,195,712 rows (211,750,965 bytes) on 2026-11-16; 8,363,206 on 2025-12-01. `exchangeMetrics` `trade_count` for 2026-11-16 is also 2,195,712.
- Open interest: `hour` (timestamptz), `symbol`, `open_interest` (base units), `mark_price`, `open_interest_usd`, `date`. 5,006 rows and 209 symbols on 2026-11-16, 118 KB.

**Market identity.** In S3, `market_id` is an internal slot that Lighter reuses, and `public_market_index` is the id the API calls `market_id`. On 2026-11-16 slot 51 traded PRL (public 4097, decimals 2/4), while public 51 is RESOLV (inactive, decimals 0/6). `public_market_index` is null in every file before 2026-08-20 and filled from partway through that day. On 2026-08-20 to 2026-08-24 no filled row differs from its slot, and the first market with a public id at or above 4095 (STONK) was created on 2026-09-15. So the public id of any row is `coalesce(public_market_index, market_id)`. Rows whose public id has no `orderBookDetails` entry are binary options: 194 slots and 14,328 rows on 2026-11-16, with trade type `market-settlement` among them.

**Units.**
- Size and price: `size / 10^size_decimals`, `price / 10^price_decimals`, notional `usdc_amount / 10^6`. Trade 40627877458 (ETH, 2026-11-16 00:36:33 UTC): `size` 3491, `price` 181952, `usdc_amount` 635194432, so 0.3491 × 1819.52 = 635.194432 USDC exactly. `size * price = usdc_amount` held on every row of 2025-01-17, 2025-06-01 and 2025-12-01, and failed on 6 of 1,829,859 rows on 2026-06-01.
- Trade fees: parts per million of notional. `maker_fee` 40, 28 and 50 match the Premium tier-0 (0.0040%), Premium 500k-LIT (0.0028%) and Plus (0.005%) maker fees on the account-types page.
- Funding: `rate` is percent per hour and `value` is USDC per one unit of base. ETH at 2026-10-17 07:00 UTC: `value` 0.01216590 / (0.0005 / 100) = 2433.18, against a mark price of 2432.00 to 2433.88 that hour. The docs say a positive rate means longs pay shorts. Lighter's own fields are an unsigned `rate` with `direction` long or short.
- Positions in a trade row (`*_position_size_before`) are signed and scaled like size; `*_entry_quote_before` like notional.

**Not yet proven, owned by Task 1:** the unit of `ask_account_pnl` and `bid_account_pnl`; whether trade ids are unique across day files; that `direction` names the paying side.

## Decisions

1. **Scope.** Plan 1 (this one): market data. Plan 2: the public account ledger and L1 settlement (Explorer account logs, positions and assets, `logs/{hash}`, batches, blocks, `account`, `accountsByL1Address`, `pnl`, `tx`, `assetDetails`, `systemConfig`, Explorer `stats/tx`). Plan 3: endpoints that need an `ro:` token (withdraw, deposit and transfer history, `positionFunding`, `liquidations`, order history). App and signing endpoints (guilds, referrals, points, RFQ, fee-credit leases, announcements, API keys, nonces) are left out. Task 1 lists every GET endpoint in `vendor.yaml` with its plan or the reason it is left out.
2. **Sources.** Six packages, all named for the chain:

   | Package | `name` / `table` | Raw table | Reads | Input |
   |---|---|---|---|---|
   | `lighter-markets` | `lighter` / `markets` | `raw.lighter_markets` | `orderBookDetails` | none |
   | `lighter-candles` | `lighter` / `candles` | `raw.lighter_candles` | `candles` and `markPriceCandles` | `markets.json` |
   | `lighter-fundings` | `lighter` / `fundings` | `raw.lighter_fundings` | `fundings` | `markets.json` |
   | `lighter-exchange-metrics` | `lighter` / `exchange_metrics` | `raw.lighter_exchange_metrics` | `exchangeMetrics` | `markets.json` |
   | `lighter-open-interest` | `lighter` / `open_interest` | `raw.lighter_open_interest` | S3 `open_interest_hourly` | none |
   | `lighter-trades` | `lighter` / `trades` | `raw.lighter_trades` | S3 `trades` | `addresses.json` |

   Trade and mark candles share one table: both are OHLC series of one market, and a `price` field (`trade` or `mark`) tells them apart. Trades come from S3, not from `/api/v1/trades`, which pages 100 at a time under the 60-a-minute limit. Task 1 uses the API endpoint only to prove the S3 fields.
3. **Shared code goes in `lib/src/lighter/`**, as `docs/architecture.md` asks for a chain client shared by several sources, and is exported as `@ingestion/lib/lighter`. The change is additive: `runSource`, `source.ts` and the other subpaths stay as they are. Each source still reads and checks its own `markets.json` or `addresses.json`.
4. **DuckDB reads Parquet.** hyparquet 1.32.0 ran out of memory (2.7 GB RSS) filtering one day file. `@duckdb/node-api` 1.5.6-r.2 downloaded and filtered it in 15 s at 375 MB RSS and returned 64-bit integers as strings. Its prebuilt bindings install with no build script. The reader downloads the whole file to a temporary folder first, so DuckDB needs no `httpfs` extension and no network.
5. **S3 progress is a manifest, not a time cursor.** Each S3 source keeps a checkpoint `{ files: { "<date>": "<etag>" } }` and loads the days whose ETag it has not loaded. A file Lighter republishes gets a new ETag and loads again, and no run downloads the same 200 MB twice. The checkpoint key hashes the bucket, prefix, dataset and, for trades, the filter. A new filter therefore loads every day again under its own manifest, as other sources do.
6. **Rate budget.** Each exchange-API source paces itself at `LIGHTER_REQUESTS_PER_MINUTE`, 15 by default, so the four running at once stay under 60. 429, 405, 5xx and network errors wait 2 s, 10 s, then 60 s, and the call becomes a dead letter after the third retry.
7. **Windows.** Candle windows hold exactly 500 buckets, and funding windows 750 hours. Both use `historyPlan` with `START_TIME` as the binance and coinbase candle sources do. Open buckets are dropped: a candle whose end is after the request, a funding hour that has not ended, and a metric point for the current UTC day.
8. **Pipeline.** `lighter`, cron `30 7 * * *`, after the S3 files land. Intermediate models are views, as for the other pipelines.
9. **Marts.**

   | Mart | One row per | Key |
   |---|---|---|
   | `lighter_markets` | market, latest reading | `market_id` |
   | `lighter_trades` | trade | `trade_id` |
   | `lighter_account_fills` | account side of a trade | `id` = `<trade_id>:<maker\|taker>` |
   | `lighter_candles` | market, price series, resolution, bucket | `id` |
   | `lighter_funding_rates` | market, hour | `id` |
   | `lighter_open_interest` | symbol, hour | `id` |
   | `lighter_exchange_metrics` | UTC day, kind, market or exchange-wide | `id` |

## Global Constraints

- Node 24 and pnpm 10.17.0 through `mise`; run tools as `mise exec -- pnpm …`.
- Package `ingestion/sources/lighter-<table>` with hyphens; `src/source.ts` exports exactly one source, with `name: "lighter"`, and `src/index.ts` calls `runSource`. Imports inside a package use `#src/…ts`.
- Each package has a `.env.example` that starts with the warehouse block from `ingestion/sources/binance-candles/.env.example` and ends with its `PUSHGATEWAY_URL` and `LOG_LEVEL` lines.
- Defaults in `.env.example` keep checks short: `START_TIME=2026-11-10T00:00:00Z` and `START_DATE=2026-11-14`.
- Raw records hold what Lighter sent. No source converts units, joins or signs anything; 64-bit integers stay strings. Staging only casts and renames.
- Read input files with `readJson` inside `extract`, so a bad file fails the run, not the import.
- The only new dependency is `"@duckdb/node-api": "1.5.6-r.2"`, in `ingestion/lib/package.json`.
- Tests never reach the network. Fake Lighter and S3 with `node:http` servers, as `binance-candles/src/source.test.ts` does, and write Parquet fixtures inside the test with DuckDB `COPY … (FORMAT parquet, COMPRESSION zstd)`.
- After adding or renaming a source, run `mise exec -- pnpm generate-sources` in `ingestion/`.
- Prose in `catalog/`, `README.md`, `docs/` and commit messages uses short words and the active voice, and cuts every word it can. Commits end with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer and carry no session link.
- Plan 1 calls no Explorer endpoint and no endpoint that needs a token.

## Review Focus

1. **A reused market slot.** A filter or join on S3's `market_id` instead of the public id puts PRL's trades under RESOLV and scales them by RESOLV's decimals. Tests: `filters markets on the public id, so a reused slot's old market stays out` (Task 9 source); `market_id_is_the_public_index_when_set` (Task 9 unit test); `lighter_trades_within_candle_range` (Task 10).
2. **Newest-N truncation.** A candle request over 500 buckets, or a funding request over 750 hours, loses its oldest rows with no error. Tests in Tasks 5 and 6 assert that every request spans at most 500 buckets or 750 hours, and that consecutive windows meet with no gap.
3. **An open bucket saved as final.** The open candle, the current funding hour (sent as 0) and today's metric point would load partial values, and nothing replaces them until the overlap window passes. Tests: `a candle still open at the request waits for the next run` (Task 5), `the hour still accruing waits for the next run` (Task 6), `today's point waits for the next run` (Task 7).
4. **A whole-market S3 load.** An `addresses.json` with neither `accounts` nor `markets` would load 2 to 8M trades a day and fill the disk; one busy market is 286k rows a day. Tests: `neither accounts nor markets fails the run` (Task 9); `yields a day in chunks of rowsPerChunk rows, ids as strings, times in UTC` (Task 3) keeps memory bounded.
5. **Lighter sources sharing one IP limit.** Four exchange-API sources at once must stay under 60 requests a minute and survive a 429. Tests: `spaces requests by 60000 / LIGHTER_REQUESTS_PER_MINUTE ms` and `a 429 waits and is sent again` (Task 2).

## Files

```
catalog/vendors/lighter/{vendor.yaml,NOTES.md}                          Task 1
ingestion/lib/src/lighter/{client.ts,client.test.ts,index.ts}           Task 2
ingestion/lib/src/lighter/{s3.ts,s3.test.ts}                            Task 3
ingestion/sources/lighter-{markets,candles,fundings,exchange-metrics,open-interest,trades}/
    package.json .env.example src/{source.ts,index.ts,source.test.ts} [markets.json|addresses.json]
transformation/models/staging/lighter/_lighter__sources.yml, _lighter__models.yml, stg_lighter__<table>.sql
transformation/models/intermediate/lighter/_int_lighter__models.yml, int_lighter_{markets,trades,funding_rates,account_fills}.sql
transformation/models/marts/lighter/_lighter__models.yml, lighter_<mart>.sql
transformation/tests/lighter_*.sql
Modified: ingestion/lib/package.json, ingestion/sources.json, ingestion/pnpm-lock.yaml,
          transformation/dbt_project.yml, orchestration/pipeline/schedules.py,
          README.md, docs/architecture.md, .claude/skills/blockjuice/workflows/history-source.md
```

---

### Task 1: The Lighter vendor catalog

**Files:**
- Create: `catalog/vendors/lighter/vendor.yaml`
- Create: `catalog/vendors/lighter/NOTES.md`

**Interfaces:**
- Produces: the field meanings, limits and proof rows that Tasks 2 to 10 cite as `catalog/vendors/lighter/NOTES.md`; the `inventory` that plans 2 and 3 start from; the answer to the pnl unit, which Task 9 needs.

- [ ] **Step 1: Write `vendor.yaml`** in the shape of `catalog/vendors/coinbase/vendor.yaml`. Fill `name: lighter`, `scope` (Lighter Core mainnet's public read API and S3 dataset; out of scope are token endpoints, WebSocket, `sendTx` and Lighter on Robinhood Chain), `docs` (the ten URLs in the request plus `developers/reference/rate-limits.md`, `developers/reference/account-types.md`, `trading/funding.md`), `sources` (the six packages), `api` (exchange, explorer and S3 hosts), `limits`, `endpoints` (the five in *What we know* with `use: source`; `trades` and `tx` with `use: proof`), `datasets` (both S3 paths and their columns) and `errors`. Add `inventory`: every GET path in `https://docs.lighter.xyz/llms.txt`, each with `plan: 1`, `2`, `3` or `out`, grouped as Decision 1 says; an `out` entry says why in a few words.
- [ ] **Step 2: Write `NOTES.md`** with sections *Hosts and limits*, *Market identity*, *Units*, *Paging traps*, *S3 files*, *Exchange metrics* and *For plan 2*. *For plan 2* holds: `tx?by=hash` returns `block_height`; Explorer `logs/{hash}` returns `block_number` and, once batched, `batch_number`; Explorer account-log entries carry no block number and page newest first by offset; a batch is a contiguous block range, and batch sizes vary. Then a proof table with one row per fact in *What we know*, each with the command that rebuilds it: P1 decimals (trade 40627877458), P2 `trade_count` equals the 2026-11-16 row count, P3 slot 51 against public 4097, P4 the first filled day of `public_market_index`, P5 the funding value against the mark price, P6 fee tiers, P7 the 500 and 750 caps and the open bucket.
- [ ] **Step 3: Prove the three open facts and add their rows.**
  - P8: `select count(*) = count(distinct id)` over the 2026-11-15 and 2026-11-16 trade files together is `true`.
  - P9: walk `GET /api/v1/trades?account_index=313004&sort_by=trade_id&limit=100` by `next_cursor` until a trade's `timestamp` falls before the current UTC day. Match 20 trade ids against the previous day's S3 file. Record whether `size`, `price`, `usd_amount`, `maker_fee` and `taker_fee` equal the scaled S3 integers, and whether the API's `ask_account_pnl` equals S3's divided by 10^6. Task 9 scales pnl only if it does.
  - P10: read `https://docs.lighter.xyz/api/funding/fundings.md` and the websocket market-stats channel for `direction`. If neither names the paying side, write that `direction` is unproven; Task 6 then keeps it as sent with no signed rate.
- [ ] **Step 4: Verify.** Rerun each proof row's command; every one prints the value written in the table.
- [ ] **Step 5: Commit.**

```bash
git add catalog/vendors/lighter
git commit -m "Add the Lighter vendor catalog: hosts, limits, units and market identity"
```

### Task 2: The Lighter exchange-API client

**Files:**
- Create: `ingestion/lib/src/lighter/client.ts`, `ingestion/lib/src/lighter/index.ts`
- Test: `ingestion/lib/src/lighter/client.test.ts`
- Modify: `ingestion/lib/package.json` (add `"./lighter": "./src/lighter/index.ts"` to `exports`)

**Interfaces:**
- Produces, from `@ingestion/lib/lighter`:

```ts
export const lighterEnv: z.ZodObject<{
  LIGHTER_API_URL: /* z.url().default("https://mainnet.zklighter.elliot.ai") */;
  LIGHTER_REQUESTS_PER_MINUTE: /* z.coerce.number().int().positive().max(60).default(15) */;
}>;
export type LighterEnv = z.infer<typeof lighterEnv>;
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const systemClock: Clock;
export class LighterError extends Error { readonly status: number; readonly code?: number; get retryable(): boolean }
/** One orderBookDetails entry; every other field stays (z.looseObject). */
export type LighterMarket = { market_id: number; symbol: string; market_type: "perp" | "spot";
  size_decimals: number; price_decimals: number } & Record<string, unknown>;
export type LighterClient = {
  get(path: string, query?: Record<string, string | number | boolean>): Promise<Record<string, unknown>>;
  markets(): Promise<LighterMarket[]>;                       // perp then spot
  resolveMarkets(symbols: readonly string[]): Promise<LighterMarket[]>;
};
export function createLighterClient(env: LighterEnv, clock?: Clock): LighterClient;
```

- [ ] **Step 1: Write the failing tests.** A `node:http` fake answers `/api/v1/orderBookDetails` with ETH (0, perp), BTC (1, perp) and `ETH/USDC` (2048, in `spot_order_book_details`), and lets each test script other replies.

```ts
test("spaces requests by 60000 / LIGHTER_REQUESTS_PER_MINUTE ms", async (t) => {
  // three gets at 15 a minute: the first goes at once, then two waits of 4000
  assert.deepEqual(clock.sleeps, [4000, 4000]);
});
test("a 429 waits and is sent again", async (t) => {
  // replies: 429, then 200 {"code":200,"x":1}
  assert.deepEqual(await client.get("/api/v1/x"), { code: 200, x: 1 });
  assert.equal(clock.sleeps.includes(2000), true);
});
test("a 400 fails at once, quoting Lighter's message", async (t) => {
  await assert.rejects(client.get("/api/v1/x"), /HTTP 400 .*20001.*invalid param : auth required/);
  assert.equal(requests.length, 1);
});
test("a reply whose code is not 200 fails", async (t) => {
  await assert.rejects(client.get("/api/v1/x"), /code 21500/); // body {"code":21500,"message":"x"}
});
test("resolveMarkets finds perp and spot symbols and fails on an unknown one, naming it", async (t) => {
  assert.deepEqual((await client.resolveMarkets(["ETH", "ETH/USDC", "ETH"])).map((m) => m.market_id), [0, 2048]);
  await assert.rejects(client.resolveMarkets(["DOGE2"]), /DOGE2/);
});
test("lighterEnv defaults the mainnet URL and 15 a minute, and refuses more than 60", () => { /* parse {} and {…:"61"} */ });
```

- [ ] **Step 2: Run them to see them fail.** `cd ingestion/lib && mise exec -- pnpm exec tsx --test src/lighter/client.test.ts`. Expected: FAIL, cannot find `#src/lighter/client.ts`.
- [ ] **Step 3: Implement `createLighterClient`** in `client.ts` on `observedFetch` and `observeDelay` from `@ingestion/lib`, shaped like `polymarket-markets/src/gamma.ts`. One request at a time. Each request starts at least `60000 / LIGHTER_REQUESTS_PER_MINUTE` ms after the previous one started. Use a 60 s timeout and retry waits `[2_000, 10_000, 60_000]` for 429, 405, 5xx and network errors. Other statuses throw `LighterError` with the status, the body's `code` and its `message`. `markets()` parses `order_book_details` and `spot_order_book_details` with `z.looseObject`. `resolveMarkets` drops repeats and keeps the first order. `index.ts` re-exports `client.ts`.
- [ ] **Step 4: Run them to see them pass.** Same command. Expected: PASS. Then `cd ingestion && mise exec -- pnpm typecheck`: no errors.
- [ ] **Step 5: Commit.**

```bash
git add ingestion/lib/src/lighter ingestion/lib/package.json
git commit -m "Add @ingestion/lib/lighter, a paced client for Lighter's exchange API"
```

### Task 3: S3 day files with DuckDB

**Files:**
- Create: `ingestion/lib/src/lighter/s3.ts`
- Test: `ingestion/lib/src/lighter/s3.test.ts`
- Modify: `ingestion/lib/src/lighter/index.ts`, `ingestion/lib/package.json` (`"@duckdb/node-api": "1.5.6-r.2"`), `ingestion/pnpm-lock.yaml`

**Interfaces:**
- Consumes: `Batch`, `Checkpoint`, `RawRecord`, `describeError` from `@ingestion/lib`.
- Produces, from `@ingestion/lib/lighter`:

```ts
export const lighterS3Env: z.ZodObject<{
  LIGHTER_S3_URL: /* z.url().default("https://aws-public-blockchain.s3.amazonaws.com") */;
  LIGHTER_S3_PREFIX: /* z.string().default("v1.1/lighter/core/mainnet") */;
}>;
export type LighterS3Env = z.infer<typeof lighterS3Env>;
export type LighterDataset = "trades" | "open_interest_hourly";   // files trades.parquet, oi.parquet
export type DayFile = { dataset: LighterDataset; date: string; key: string; etag: string; size: number };
export type DayCall = { date: string; etag: string };
export const dayCallSchema: z.ZodType<DayCall>;
export function listDays(env: LighterS3Env, dataset: LighterDataset, from: string, to: string): Promise<DayFile[]>;
export function readDay(env: LighterS3Env, file: DayFile,
  options?: { where?: string; rowsPerChunk?: number /* 10_000 */; tmpDir?: string }): AsyncGenerator<Record<string, unknown>[]>;
export function dayManifest(key: string, saved: unknown, days: readonly DayFile[]):
  { pending: DayFile[]; loaded(day: DayFile): Checkpoint };
export function dayBatches(env: LighterS3Env, file: DayFile, options: {
  where?: string; rowId(row: Record<string, unknown>): string; checkpoint: Checkpoint; rowsPerChunk?: number;
}): AsyncGenerator<Batch<DayCall>>;
```

`dayBatches` decides what a reader cannot see from the signatures. The call id is `<dataset>:<date>`. It reads one chunk ahead, so every batch but the last gives its records the call id `<dataset>:<date>#<n>`. The last batch gives its records the day's own call id, and carries `succeededCallIds: [id]`, `callsCompleted: 1` and the checkpoint. A day with no matching rows yields that last batch with no records. An error yields `{ records: [], failed: [{ id, call, error }], callsCompleted: 1 }` and no checkpoint. A day that fails halfway keeps the chunks it already wrote, and the retry rewrites them by id.

- [ ] **Step 1: Write the failing tests.** The fake S3 answers `?list-type=2&prefix=…` with two XML pages joined by `NextContinuationToken`. It serves Parquet files that the test writes with DuckDB from rows like trade 40627877458.

```ts
test("listDays follows continuation tokens and keeps the dates in range", async (t) => {
  // keys for 2026-11-14, -15 and -16 over two pages, plus the folder key
  assert.deepEqual((await listDays(env, "trades", "2026-11-15", "2026-11-16")).map((d) => [d.date, d.etag]),
    [["2026-11-15", "e15"], ["2026-11-16", "e16"]]);   // ETag quotes stripped
});
test("yields a day in chunks of rowsPerChunk rows, ids as strings, times in UTC", async (t) => {
  const chunks = await collect(readDay(env, day, { where: "ask_account_id in (313004) or bid_account_id in (313004)", rowsPerChunk: 2 }));
  assert.deepEqual(chunks.map((c) => c.length), [2, 1]);
  assert.equal(chunks[0][0].id, "40627877458");
  assert.match(String(chunks[0][0].created_at), /\+00$/);
});
test("a failed or short download fails, naming the key, and leaves no temporary file", async (t) => {
  await assert.rejects(collect(readDay(env, day, { tmpDir })), /date=2026-11-16.*HTTP 500/);
  await assert.rejects(collect(readDay(env, shortDay, { tmpDir })), /expected 4096 bytes/);
  assert.deepEqual(await readdir(tmpDir), []);
});
test("dayManifest skips days loaded with the same ETag and reloads a changed one", () => {
  const m = dayManifest("k", { files: { "2026-11-15": "a" } }, [d15("a"), d16("b")]);
  assert.deepEqual(m.pending.map((d) => d.date), ["2026-11-16"]);
  assert.deepEqual(dayManifest("k", { files: { "2026-11-15": "a" } }, [d15("c")]).pending.length, 1);
  m.loaded(d16("b"));
  assert.deepEqual(m.loaded(d15("a")).value, { files: { "2026-11-15": "a", "2026-11-16": "b" } });
});
test("dayBatches clears the day's dead letter only with its last chunk", async (t) => {
  const batches = await collect(dayBatches(env, day, { rowId: (r) => String(r.id), checkpoint, rowsPerChunk: 2 }));
  assert.deepEqual(batches.map((b) => [b.records.map((r) => r.callId), b.succeededCallIds]),
    [[["trades:2026-11-16#0", "trades:2026-11-16#0"], undefined], [["trades:2026-11-16"], ["trades:2026-11-16"]]]);
  assert.deepEqual(batches.at(-1)!.checkpoints, [checkpoint]);
});
test("dayBatches turns a failed day into a dead letter with no checkpoint", async (t) => { /* 500 → failed[0].id "trades:2026-11-16" */ });
```

- [ ] **Step 2: Run them to see them fail.** `cd ingestion/lib && mise exec -- pnpm exec tsx --test src/lighter/s3.test.ts`. Expected: FAIL, cannot find `#src/lighter/s3.ts`.
- [ ] **Step 3: Implement `s3.ts`.** `listDays` parses `<Key>`, `<ETag>` and `<Size>` with a regex (there is no AWS SDK) and keeps keys matching `/date=(\d{4}-\d{2}-\d{2})\/(trades|oi)\.parquet$/`. `readDay` streams the object into `mkdtemp(<tmpDir or os.tmpdir()>/lighter-)` and checks the byte count against `size`. It opens an in-memory DuckDB with `memory_limit '512MB'`, `threads 2` and `TimeZone 'UTC'`, and runs `select * from read_parquet('<file>') [where <where>]` through `connection.stream`. It regroups `result.yieldRowObjectJson()` into chunks of `rowsPerChunk`, and removes the folder in `finally`. `where` is trusted SQL; callers build it only from validated integers.
- [ ] **Step 4: Run them to see them pass.** Same command, then `cd ingestion && mise exec -- pnpm typecheck`. Expected: PASS, no errors.
- [ ] **Step 5: Commit.**

```bash
git add ingestion/lib ingestion/pnpm-lock.yaml
git commit -m "Read Lighter's S3 day files with DuckDB, one day at a time"
```

### Task 4: Markets, the `lighter` pipeline and `lighter_markets`

**Files:**
- Create: `ingestion/sources/lighter-markets/{package.json,.env.example,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `transformation/models/staging/lighter/{_lighter__sources.yml,_lighter__models.yml,stg_lighter__markets.sql}`
- Create: `transformation/models/intermediate/lighter/{_int_lighter__models.yml,int_lighter_markets.sql}`
- Create: `transformation/models/marts/lighter/{_lighter__models.yml,lighter_markets.sql}`
- Modify: `ingestion/sources.json`, `ingestion/pnpm-lock.yaml`, `transformation/dbt_project.yml` (`intermediate: lighter: +materialized: view`), `orchestration/pipeline/schedules.py` (`"lighter": "30 7 * * *"`), `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: `createLighterClient`, `lighterEnv`, `Clock`, `systemClock` (Task 2).
- Produces: `raw.lighter_markets` records `{ id: "<market_id>:<read_at>", callId: "order_book_details", data: { read_at, market } }`; `int_lighter_markets` (latest reading per `market_id`) with columns `market_id, symbol, market_type, size_decimals, price_decimals, quote_decimals, …`, which Tasks 8 to 10 join on.

- [ ] **Step 1: Write the failing tests** (`marketsSource(clock)` returns the source, `lighterMarkets = marketsSource()` is the export).

```ts
test("each run reads every perp and spot market once, keyed by market and read time", async (t) => {
  // clock.now() = 1794918000000; fake has ETH 0, BTC 1, ETH/USDC 2048
  assert.deepEqual(batch.records.map((r) => r.id), ["0:1794918000000", "1:1794918000000", "2048:1794918000000"]);
  assert.equal((batch.records[2].data.market as { symbol: string }).symbol, "ETH/USDC");
});
test("a failed read waits as a dead letter", async (t) => { /* 500 four times → failed[0].id "order_book_details", no records */ });
test("a retried read is made once, by the run's own call", async (t) => { /* retry [{kind:"order_book_details"}] → 1 request */ });
```

- [ ] **Step 2: Run them to see them fail.** `cd ingestion/sources/lighter-markets && mise exec -- pnpm test`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement the source.** It has `name: "lighter"`, `table: "markets"`, `env: lighterEnv`, and `call: z.object({ kind: z.literal("order_book_details") })`. `read_at` is `clock.now()` at the start of `extract`. Then run `cd ingestion && mise exec -- pnpm install && mise exec -- pnpm generate-sources`.
- [ ] **Step 4: Add the models.** `stg_lighter__markets` casts `read_at` (ms to timestamptz), `market_id`, `symbol`, `market_type`, `base_asset_id`, `quote_asset_id`, `status`, `size_decimals`, `price_decimals`, `supported_quote_decimals as quote_decimals`, `maker_fee` and `taker_fee` as numeric `maker_fee_pct` and `taker_fee_pct`, `min_base_amount`, `min_quote_amount`, and `created_at` (ms to timestamptz). `int_lighter_markets` keeps each `market_id`'s latest `read_at`. The `lighter_markets` mart selects it, with tests `unique` and `not_null` on `market_id`, `not_null` on `symbol` and both decimals, and `accepted_values` `[perp, spot]` on `market_type`. Add a unit test, `int_lighter_markets_keeps_the_latest_reading`: market 0 read at two times with `size_decimals` 4, then 5, gives one row with 5.
- [ ] **Step 5: Document it.** Add a `Lighter` column to the README grid, a *Lighter markets* section in the shape of *HyperCore fills*, a paragraph on the `lighter` pipeline to *What ships today* in `docs/architecture.md`, and `(cd ingestion/sources/lighter-markets && pnpm ingest)` to its list of commands.
- [ ] **Step 6: Verify.** `mise exec -- pnpm test` in the package and `mise exec -- pnpm typecheck` in `ingestion/` pass. `cd orchestration && uv run pytest` passes, including `test_every_asset_and_check_runs_in_a_scheduled_pipeline` and `test_sources_json_is_fresh`. `uv run --project orchestration bj run lighter` succeeds, and `select count(*) from analytics.lighter_markets` returns about 256.
- [ ] **Step 7: Commit.**

```bash
git add ingestion transformation orchestration/pipeline/schedules.py README.md docs/architecture.md
git commit -m "Load Lighter's markets and start the lighter pipeline with lighter_markets"
```

### Task 5: Trade and mark-price candles

**Files:**
- Create: `ingestion/sources/lighter-candles/{package.json,.env.example,markets.json,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `transformation/models/staging/lighter/stg_lighter__candles.sql`, `transformation/models/marts/lighter/lighter_candles.sql`, `transformation/tests/lighter_candles_one_row_per_bucket.sql`
- Modify: `_lighter__sources.yml`, `_lighter__models.yml` (staging and marts), `ingestion/sources.json`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: `createLighterClient`, `lighterEnv` (Task 2); `historyKey`, `historyPlan`, `historyState`, `callBatches` from `@ingestion/lib`.
- Produces: `CandleCall = { market_id: number; symbol: string; price: "trade" | "mark"; resolution: Resolution; start_time: number; end_time: number }` with id `<market_id>:<price>:<resolution>:<start_time>`; records `{ id: "<market_id>:<price>:<resolution>:<t>", data: { market_id, symbol, price, resolution, candle } }`; mart `lighter_candles` (`market_id, symbol, price, resolution, open_time, open, high, low, close, base_volume, quote_volume, last_trade_id, samples`), which Task 10 joins.

The env is `lighterEnv.extend({ CANDLE_RESOLUTION: z.enum(["1m","5m","15m","30m","1h","4h","12h","1d"]).default("1h"), START_TIME, HISTORY_OVERLAP_DAYS, HISTORY_REFRESH_DAYS, HISTORY_FULL_REFRESH })`, with `START_TIME` parsed as in `coinbase-candles`. `markets.json` is `{ "markets": ["ETH", "BTC"] }` and must list at least one symbol. A window is `[start_time, start_time + 500 × span − 1]`; trade windows go to `/api/v1/candles` and mark windows to `/api/v1/markPriceCandles`, each with `count_back=0`. Plans are keyed by `historyKey(["lighter", LIGHTER_API_URL, symbol, price, resolution, START_TIME])`, and the batch checkpoints work as in `coinbase-candles`.

- [ ] **Step 1: Write the failing tests.** The fake serves 1,200 hourly candles per market and price, and like Lighter returns only the newest 500 of any longer range.

```ts
test("loads trade and mark candles in windows of 500 that meet with no gap", async (t) => {
  for (const r of requests) assert.ok((r.end - r.start + 1) / HOUR <= 500);
  assert.deepEqual(windowsOf("ETH", "trade"), [[0, 500 * HOUR - 1], [500 * HOUR, 1000 * HOUR - 1], [1000 * HOUR, 1500 * HOUR - 1]]);
  assert.equal(records.filter((r) => r.data.price === "mark").length, closedCandles);
});
test("a candle still open at the request waits for the next run", async (t) => { /* now inside the last hour → no record for it */ });
test("markets.json with an unknown symbol fails the run, naming it", async (t) => { /* /DOGE2/ */ });
test("an empty markets list fails the run", async (t) => { /* /markets.json lists no markets/ */ });
test("a failed window waits as a dead letter, and the other windows load", async (t) => {});
test("committed history resumes, and a routine run reads only the recent windows", async (t) => {});
```

- [ ] **Step 2: Run them to see them fail.** `cd ingestion/sources/lighter-candles && mise exec -- pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement the source.** It keeps a candle only when `t ≥ start_time`, `t ≤ end_time` and `t + span ≤` the time the request was sent. Then run `pnpm install` and `pnpm generate-sources`.
- [ ] **Step 4: Add the models.** `stg_lighter__candles` casts `open_time` from `t` in ms, `o`/`h`/`l`/`c` as numeric, `base_volume` (`v`), `quote_volume` (`V`), `last_trade_id` (`i`) and `samples` (`sc`). For trade candles a missing `v`, `V` or `i` is 0, because Lighter leaves zero fields out (NOTES, *Paging traps*); mark candles leave them null. The `lighter_candles` mart selects staging. Its tests: `not_null` on prices and `open_time`, `accepted_values` `[trade, mark]` on `price`, and the singular test `lighter_candles_one_row_per_bucket` (no two rows share market, price, resolution and `open_time`).
- [ ] **Step 5: Document** the mart in README and the source in `docs/architecture.md`.
- [ ] **Step 6: Verify.** Package tests, `pnpm typecheck` and `uv run pytest` pass. `bj run lighter --select lighter/candles lighter_candles` with ETH and BTC from `2026-11-10` loads 2 markets × 2 series × about 170 hourly rows. Cross-check one ETH trade candle's `close` against `GET /api/v1/candles` for that hour.
- [ ] **Step 7: Commit** (`git commit -m "Load Lighter's trade and mark-price candles into lighter_candles"`).

### Task 6: Funding rates

**Files:**
- Create: `ingestion/sources/lighter-fundings/{package.json,.env.example,markets.json,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__fundings.sql`, `transformation/models/intermediate/lighter/int_lighter_funding_rates.sql`, `transformation/models/marts/lighter/lighter_funding_rates.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Produces: `FundingCall = { market_id, symbol, start_time, end_time }` (ms), id `<market_id>:<start_time>`; records `{ id: "<market_id>:<timestamp>", data: { market_id, symbol, funding } }`; mart `lighter_funding_rates` (`id, market_id, symbol, funding_time, rate_pct, signed_rate_pct, value_usdc_per_unit, direction`).

Windows are 750 hours, `[start, start + 750 h − 1 ms]`, with `resolution=1h`. The env and history are as in Task 5, without `CANDLE_RESOLUTION`. An entry loads only when `timestamp × 1000 + 3_600_000 ≤` the time the request was sent.

- [ ] **Step 1: Write the failing tests:** `loads every market's funding in windows of 750 hours that meet with no gap`; `the hour still accruing waits for the next run` (the newest entry, sent as `"0.00000000"`, is not loaded); `a failed window waits as a dead letter`; `markets.json with an unknown symbol fails the run, naming it`.
- [ ] **Step 2: Run them to see them fail.** `cd ingestion/sources/lighter-fundings && mise exec -- pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement the source**, then `pnpm install` and `pnpm generate-sources`.
- [ ] **Step 4: Add the models.** Staging casts `funding_time` from `timestamp` in seconds, `rate_pct` and `value_usdc_per_unit` as numeric, and `direction`. `int_lighter_funding_rates` adds `signed_rate_pct` = `rate_pct` when `direction = 'long'`, `-rate_pct` when it is `'short'`: positive means longs pay. If Task 1's P10 left `direction` unproven, leave `signed_rate_pct` out and say so in the mart's description. Unit test `funding_rate_is_signed_by_direction`, from ETH at 2026-10-17 07:00 UTC (rate 0.0005, long, gives 0.0005) and one short row (gives −0.0003). Mart tests: `unique` on `id`, `not_null` on `rate_pct` and `funding_time`, `accepted_values` `[long, short]` on `direction`.
- [ ] **Step 5: Document**, then **verify**: package tests, typecheck, pytest and `bj run lighter --select lighter/fundings lighter_funding_rates` pass, and each market has 24 rows per full UTC day.
- [ ] **Step 6: Commit** (`git commit -m "Load Lighter's hourly funding into lighter_funding_rates"`).

### Task 7: Exchange metrics

**Files:**
- Create: `ingestion/sources/lighter-exchange-metrics/{package.json,.env.example,markets.json,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__exchange_metrics.sql`, `lighter_exchange_metrics.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Produces: `MetricCall = { kind: Kind; market: string | null }`, id `<kind>:<market or all>`; records `{ id: "<kind>:<market or all>:<timestamp>", data: { kind, market, point } }`; mart `lighter_exchange_metrics` (`id, day, kind, market, value`; `market` is null for exchange-wide).

`EXCHANGE_KINDS` holds the 18 kinds in *What we know*, and `MARKET_KINDS` the 10 that honour `byMarket`. `tps` is left out: it is a live five-minute series, not a daily one. Every run reads every call again, because each reply is the whole daily series. `markets.json` may list no markets; then only exchange-wide calls go out.

- [ ] **Step 1: Write the failing tests:** `reads every kind exchange-wide and the market kinds for each listed market` (with `["ETH"]`: 18 + 10 requests, the market ones carrying `filter=byMarket&value=ETH`); `today's point waits for the next run` (a point whose UTC day has not ended is dropped); `a failed kind waits as a dead letter, and the others load`; `markets.json with an unknown symbol fails the run, naming it`.
- [ ] **Step 2: Run them to see them fail**, then **Step 3: implement** the source, and run `pnpm install` and `pnpm generate-sources`.
- [ ] **Step 4: Add the models.** Staging casts `day` (`to_timestamp(timestamp) at time zone 'UTC'`, as a date), `kind`, `market` and `value` as numeric. The mart description gives each kind's unit (USDC for volumes, fees, flows and `open_interest`; LIT for `buyback`; a count for the rest). Tests: `unique` on `id`; `accepted_values` on `kind`.
- [ ] **Step 5: Document, verify and commit.** `bj run lighter --select lighter/exchange_metrics lighter_exchange_metrics` passes, and `select value from analytics.lighter_exchange_metrics where kind = 'trade_count' and market is null and day = '2026-11-16'` returns 2195712. Commit: `git commit -m "Load Lighter's daily exchange metrics into lighter_exchange_metrics"`.

### Task 8: Hourly open interest from S3

**Files:**
- Create: `ingestion/sources/lighter-open-interest/{package.json,.env.example,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__open_interest.sql`, `lighter_open_interest.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: `lighterS3Env`, `listDays`, `dayManifest`, `dayBatches`, `dayCallSchema` (Task 3).
- Produces: records `{ id: "<symbol>:<hour>", data: <row> }`; mart `lighter_open_interest` (`id, hour, symbol, open_interest, mark_price, open_interest_usd`).

The env is `lighterS3Env.extend({ START_DATE: z.iso.date(), END_DATE: z.iso.date().optional() })`, and `END_DATE` must not come before `START_DATE`. Days are listed from `START_DATE` to `END_DATE`, or to yesterday in UTC when it is unset. The manifest key is `historyKey(["lighter", LIGHTER_S3_URL, LIGHTER_S3_PREFIX, "open_interest_hourly"])`. Days load one after another; a retried call whose date is pending is dropped, and any other retried call reads the date's current file.

- [ ] **Step 1: Write the failing tests:** `loads each listed day once, and skips a day loaded with the same ETag`; `a day whose ETag changed loads again`; `a failed day waits as a dead letter, and the next day still loads`; `START_DATE is required, and END_DATE may not precede it`.
- [ ] **Step 2: Run them to see them fail**, then **Step 3: implement** the source, and run `pnpm install` and `pnpm generate-sources`.
- [ ] **Step 4: Add the models.** Staging casts `hour` as timestamptz and the three values as numeric. Mart tests: `unique` on `id`; `not_null` on `hour`, `symbol` and `open_interest`.
- [ ] **Step 5: Document, verify and commit.** `bj run lighter --select lighter/open_interest lighter_open_interest` from `2026-11-14` loads 3 days of about 5,000 rows each, and a second run downloads nothing. Commit: `git commit -m "Load Lighter's hourly open interest from S3 into lighter_open_interest"`.

### Task 9: Trades from S3 and `lighter_trades`

**Files:**
- Create: `ingestion/sources/lighter-trades/{package.json,.env.example,addresses.json,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__trades.sql`, `int_lighter_trades.sql`, `lighter_trades.sql`, `transformation/tests/lighter_trades_have_a_market.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `README.md`, `docs/architecture.md`, `.claude/skills/blockjuice/workflows/history-source.md`

**Interfaces:**
- Consumes: Task 2's client (to resolve market symbols) and Task 3's S3 functions; `int_lighter_markets` (Task 4).
- Produces: records `{ id: <trade id>, data: <row> }`; `int_lighter_trades` and mart `lighter_trades` with columns `trade_id, trade_time, block_number, tx_hash, trade_type, market_id, slot_market_id, symbol, market_type, price, size, notional_usdc, is_maker_ask, maker_account_index, taker_account_index, taker_side, ask_account_index, bid_account_index, maker_fee_ppm, taker_fee_ppm, maker_fee_usdc, taker_fee_usdc, integrator_maker_fee_usdc, integrator_taker_fee_usdc, ask_order_index, bid_order_index` plus the scaled position fields Task 10 reads (`maker_position_before`, `taker_position_before`, `maker_entry_quote_before_usdc`, `taker_entry_quote_before_usdc`, `ask_account_pnl`, `bid_account_pnl`, and both `*_position_sign_changed`).

The env is `lighterEnv.extend(lighterS3Env.shape).extend({ START_DATE, END_DATE })`, with dates as in Task 8. `addresses.json` is `{ "accounts"?: number[], "markets"?: string[] }` (shipped as `{ "accounts": [313004], "markets": ["ETH"] }`). A present key must list at least one valid entry; account indexes are non-negative safe integers. With neither key, the run fails with: `addresses.json lists no accounts and no markets. List at least one: one day of Lighter trades is 2 to 8 million rows.` The `where` clause is `(ask_account_id in (A) or bid_account_id in (A))` for accounts and `coalesce(public_market_index, market_id) in (M)` for markets, joined by `and` when both keys are present. `M` holds the public ids from `resolveMarkets`. The manifest key is `historyKey(["lighter", LIGHTER_S3_URL, LIGHTER_S3_PREFIX, "trades", sorted A, sorted M])`.

- [ ] **Step 1: Write the failing source tests:**

```ts
test("neither accounts nor markets fails the run", async (t) => { /* /2 to 8 million rows/ */ });
test("an empty or malformed list fails the run, naming the key", async (t) => { /* {"accounts":[]}, {"accounts":["x"]} */ });
test("loads the listed accounts' trades from each day file, keyed by trade id", async (t) => {
  assert.deepEqual(records.map((r) => r.id), ["40627877458", "40627877460"]);
});
test("filters markets on the public id, so a reused slot's old market stays out", async (t) => {
  // rows: A slot 51 / public 4097 (PRL); B slot 51 / public null (RESOLV, before 2026-08-20)
  assert.deepEqual(idsFor(["PRL"]), ["A"]);
  assert.deepEqual(idsFor(["RESOLV"]), ["B"]);
});
test("a changed addresses.json loads every day again under a new manifest", async (t) => {});
```

- [ ] **Step 2: Run them to see them fail**, then **Step 3: implement** the source on `dayBatches`, and run `pnpm install` and `pnpm generate-sources`.
- [ ] **Step 4: Write the failing dbt unit tests** on `int_lighter_trades`, with `int_lighter_markets` rows for ETH (0, 4/2/6), RESOLV (51, 0/6/6) and PRL (4097, 2/4/6):
  - `size_and_price_scale_by_the_market_decimals`: trade 40627877458 (`size` 3491, `price` 181952, `usdc_amount` 635194432, slot 0) gives `size` 0.3491, `price` 1819.52, `notional_usdc` 635.194432.
  - `market_id_is_the_public_index_when_set`: slot 51 with public 4097 gives `market_id` 4097 and `symbol` PRL; slot 51 with a null public index gives 51 and RESOLV.
  - `the_maker_is_the_ask_when_is_maker_ask`: the same trade (`is_maker_ask` true, ask 757337, bid 313004) gives `maker_account_index` 757337, `taker_account_index` 313004 and `taker_side` buy.
  - `fees_are_parts_per_million_of_notional`: `maker_fee` 50 on 635.194432 gives `maker_fee_usdc` 0.0317597216.

  Run `cd transformation && ../orchestration/.venv/bin/dbt test --select int_lighter_trades,test_type:unit` with `.env` loaded. Expected: FAIL, the model does not exist.
- [ ] **Step 5: Add the models.** `stg_lighter__trades` casts every column, renaming `id` to `trade_id`, `market_id` to `slot_market_id` and `l2_block_height` to `block_number`, and every scaled integer to `<name>_raw`; `trade_time` comes from `timestamp` in ms. `int_lighter_trades` applies the rules in *What we know*, each with a comment that cites its NOTES section, and left-joins `int_lighter_markets` on `market_id`. It divides `ask_account_pnl` and `bid_account_pnl` by 10^6 only if Task 1's P9 proved that; otherwise it keeps them as `*_raw`. Mart tests: `unique` and `not_null` on `trade_id`; `not_null` on `market_id`, `trade_time`, `size_raw` and `price_raw`; `accepted_values` on `trade_type` (`trade, liquidation, deleverage, market-settlement`). Add `lighter_trades_have_a_market` with `severity: warn`; it lists the binary-option markets that have no row in `lighter_markets`.
- [ ] **Step 6: Run the unit tests to see them pass**, using the same command. Expected: PASS.
- [ ] **Step 7: Document.** Add a README section for `lighter_trades`. In `docs/architecture.md`, add the source paragraph and its `pnpm ingest` line. Add the row `| Lighter trades | Nothing: set accounts, markets or both in ingestion/sources/lighter-trades/addresses.json |` to the copy table in `history-source.md`.
- [ ] **Step 8: Verify.** Package tests, typecheck and pytest pass. `bj run lighter --select lighter/trades lighter_trades` from `2026-11-14`, with the shipped `addresses.json`, loads 13,521 trades for 2026-11-16 (that day the account traded only ETH), and trade 40627877458 has `notional_usdc` 635.194432.
- [ ] **Step 9: Commit** (`git commit -m "Load Lighter trades from S3 and build lighter_trades"`).

### Task 10: Account fills and the cross-checks

**Files:**
- Create: `transformation/models/intermediate/lighter/int_lighter_account_fills.sql`, `transformation/models/marts/lighter/lighter_account_fills.sql`
- Create: `transformation/tests/lighter_trades_within_candle_range.sql`, `transformation/tests/lighter_account_fills_positions_chain.sql`
- Modify: the lighter yml files, `README.md`

**Interfaces:**
- Consumes: `int_lighter_trades` (Task 9), `lighter_candles` (Task 5).
- Produces: `lighter_account_fills` (`id, trade_id, trade_time, market_id, symbol, account_index, role, side, signed_size, price, notional_usdc, fee_ppm, fee_usdc, position_before, position_after, entry_quote_before_usdc, position_sign_changed, realized_pnl`). `realized_pnl` is in USDC if P9 proved the scale, and named `realized_pnl_raw` otherwise.

`int_lighter_account_fills` stacks two rows per trade with `union all`. The maker row takes the maker account and maker fields; the taker row takes the taker's. `side` is `sell` for the ask account and `buy` for the bid account. `signed_size` is `+size` for a buy and `−size` for a sell, and `position_after = position_before + signed_size`. `realized_pnl` comes from `ask_account_pnl` on the sell row and `bid_account_pnl` on the buy row.

- [ ] **Step 1: Write the failing dbt unit tests** on `int_lighter_account_fills`:
  - `a_trade_gives_a_maker_row_and_a_taker_row`: trade 40627877458 gives `40627877458:maker` (account 757337, sell, −0.3491) and `40627877458:taker` (account 313004, buy, +0.3491).
  - `position_after_adds_the_signed_size`: the taker's `taker_position_size_before_raw` 0 gives `position_after` 0.3491. The maker's `maker_position_size_before_raw` −2252 (ETH, 4 decimals) gives `position_before` −0.2252 and `position_after` −0.5743.
- [ ] **Step 2: Run them to see them fail.** `dbt test --select int_lighter_account_fills,test_type:unit`. Expected: FAIL.
- [ ] **Step 3: Implement the model and mart.** Mart tests: `unique` and `not_null` on `id`; `accepted_values` `[maker, taker]` on `role` and `[buy, sell]` on `side`; `not_null` on `signed_size` and `position_after`.
- [ ] **Step 4: Add the cross-checks.**
  - `lighter_trades_within_candle_range` (error): every trade whose market and hour have a 1h trade candle in `lighter_candles` has a `price` between that candle's `low` and `high`, allowing a relative error of 1e-9 for the candle's JSON doubles. It catches wrong decimals and wrong market ids.
  - `lighter_account_fills_positions_chain` (`severity: warn`): over each account and market, ordered by `trade_id`, `position_before` equals the previous row's `position_after`. A row with no previous row is skipped. Warn, not error, because a change that is not a trade (an exit at delisting, for one) also moves a position, and plan 2 loads those.
- [ ] **Step 5: Run every lighter test to see it pass.** `dbt build --select +lighter_account_fills lighter_trades_within_candle_range`. Expected: PASS, and the chain test's warning count is reported.
- [ ] **Step 6: Document, verify and commit.** Add the README section. `bj run lighter` (the whole pipeline) succeeds. For account 313004 on 2026-11-16, `lighter_account_fills` has one row for each of its fills. Commit: `git commit -m "Build lighter_account_fills with positions after each fill, and cross-check trades against candles"`.
