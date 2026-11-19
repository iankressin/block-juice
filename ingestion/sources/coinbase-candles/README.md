# coinbase-candles

## Overview

A call source that reads candles for each token in `tokens.json` from Coinbase Exchange's public market data and loads them into `raw.coinbase_candles`. Each call is one window of up to 300 candles of one market. dbt reads the table through `transformation/models/staging/coinbase/stg_coinbase__candles.sql`. The API's endpoints and limits are in `catalog/vendors/coinbase/`.

## Interface

- `src/source.ts:coinbaseCandles`: `candlesSource()` with the system clock, the `Source<CoinbaseEnv, CandleCall>` that `src/index.ts` runs through `runSource`. `name` is `coinbase`, `table` is `candles`, `retryMode` is `paged`.
- `src/source.ts:candlesSource(clock)`: the same source with a given `Clock`, for tests.
- `src/source.ts:CoinbaseEnv`:
  - `COINBASE_API_URL`: defaults to Coinbase Exchange's public API, which needs no key.
  - `CANDLE_INTERVAL`: one of `1m`, `5m`, `15m`, `1h`, `6h`, `1d`; default `1h`.
  - `START_TIME`: required, an ISO date or datetime.
  - `HISTORY_OVERLAP_DAYS` (default 3), `HISTORY_REFRESH_DAYS` (default 7), `HISTORY_FULL_REFRESH` (`0` or `1`): read by `historyPlan` in `ingestion/lib/src/history.ts`.
  - `COINBASE_MAX_CONCURRENCY`: calls sent at once, 1 to 10, default 5.
- `src/coinbase.ts:createCoinbaseClient(url, clock)` / `CoinbaseClient`: `product(id)` reads `/products/<id>`; `candles(query)` reads `/products/<id>/candles` and sorts them oldest first; `waitForRate()` waits until a second has passed since the last group.
- `src/coinbase.ts:CoinbaseError`: `notFound` is HTTP 404; `rateLimited` is HTTP 429.
- `src/coinbase.ts:Clock`, `systemClock`, `Candle`, `Product`.
- `src/candles.ts`: `interval` / `Interval`, `granularity`, `parseTokens(json)` / `Market`, `candleCallSchema` / `CandleCall` (`{ kind: "candles", product_id, base_asset, quote_asset, interval, start_time, end_time }`), `callId`, `checkMarket`, `bucketStart`, `windowSpan`, `iterateWindowCalls`, `windowCalls` and `fetchWindows`.
- `tokens.json`: `quote` and `tokens`, capital letters and digits. Each market's id is `<token>-<quote>`, such as `UNI-USD`.
- `.env.example`: the warehouse settings, the settings above, `PUSHGATEWAY_URL` and `LOG_LEVEL`.

## Invariants

- The call id is `<product_id>:<interval>:<start_time>` (`src/candles.ts:callId`). The record id is `<product_id>:<interval>:<open_time>`, so a rerun replaces a candle.
- Each record's `data` holds `product_id`, `base_asset`, `quote_asset`, `interval`, `open_time` and `close_time` (epoch milliseconds), `open`, `high`, `low`, `close` and `volume`.
- Intervals use Binance's names, so `token_prices` reads candles from both exchanges alike. Coinbase takes the length in seconds (`granularity`).
- `fetchWindows` reads the clock before each call and keeps only candles that closed before it and open inside the call's window.
- Every call that succeeds is listed in `succeededCallIds`, so a window with no closed candles still clears its dead letter.
- `checkMarket` runs before any window, in groups of `COINBASE_MAX_CONCURRENCY` markets with a `waitForRate()` before each group. An unknown product fails the run and names the token. A market not trading only warns. Any other failure warns and lets the market's windows go ahead.
- Windows start on the epoch grid (`bucketStart`) and span 300 candles, Coinbase's most per call.
- Rate: the client sends one group of calls a second, and `COINBASE_MAX_CONCURRENCY` is capped at 10, Coinbase's public limit a second. Each attempt counts. A 429 waits and tries again after 1 and 2 seconds (`RETRY_WAITS_MS`), then fails the call, which waits in `_dead_letters`.
- Each market's progress is a checkpoint keyed by `historyKey` over the whole `COINBASE_API_URL`, market, interval and `START_TIME`. A run resumes unfinished history, revisits the last `HISTORY_OVERLAP_DAYS`, and sweeps all of it every `HISTORY_REFRESH_DAYS` or when `HISTORY_FULL_REFRESH=1`.
- `callBatches` sends retried calls before fresh ones, except a retry that the fresh plan already covers (`isFresh`), which goes out once as a fresh call.
- `tokens.json` is read inside `extract` with `readJson`, and `parseTokens` fails the run on a bad file.

## Side Effects

- HTTP GETs to `COINBASE_API_URL` through `observedFetch`, each with a 30-second timeout (`TIMEOUT_MS`). Waits go through `observeDelay`.
- `runSource` writes the records to `raw.coinbase_candles`, failed calls to `raw._dead_letters`, one row per run to `raw._ingestion_inputs`, progress to `raw._checkpoints`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set, and logs through the pino `logger`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/coinbase-candles test`
- Run: `pnpm -C ingestion typecheck`
