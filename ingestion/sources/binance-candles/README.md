# binance-candles

## Overview

A call source that reads candles for each token in `tokens.json` from Binance's public market data and loads them into `raw.binance_candles`. Each call is one window of up to 1000 candles of one market. dbt reads the table through `transformation/models/staging/binance/stg_binance__candles.sql`. The API's endpoints and limits are in `catalog/vendors/binance/`.

## Interface

- `src/source.ts:binanceCandles`: `candlesSource()` with the system clock, the `Source<BinanceEnv, CandleCall>` that `src/index.ts` runs through `runSource`. `name` is `binance`, `table` is `candles`, `retryMode` is `paged`.
- `src/source.ts:candlesSource(clock)`: the same source with a given `Clock`, for tests.
- `src/source.ts:BinanceEnv`:
  - `BINANCE_API_URL`: defaults to Binance's market-data host.
  - `CANDLE_INTERVAL`: one of `1m`, `3m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `8h`, `12h`, `1d`, `3d`, `1w`; default `1h`.
  - `START_TIME`: required, an ISO date or datetime.
  - `HISTORY_OVERLAP_DAYS` (default 3), `HISTORY_REFRESH_DAYS` (default 7), `HISTORY_FULL_REFRESH` (`0` or `1`): read by `historyPlan` in `ingestion/lib/src/history.ts`.
  - `BINANCE_MAX_CONCURRENCY`: calls sent at once, 1 to 100, default 5.
- `src/binance.ts:createBinanceClient(url, clock)` / `BinanceClient`: `candles(query)` reads `/api/v3/klines`; `waitForWeight()` waits for the next minute once this minute's weight is spent.
- `src/binance.ts:BinanceError`: `banned` is HTTP 418; `invalidSymbol` is code `-1121`.
- `src/binance.ts:Clock`, `systemClock`, `Candle`.
- `src/candles.ts`: `interval` / `Interval`, `parseTokens(json)` / `Market`, `candleCallSchema` / `CandleCall` (`{ kind: "candles", symbol, base_asset, quote_asset, interval, start_time, end_time }`), `callId`, `firstOpenTime`, `windowSpan`, `iterateWindowCalls`, `windowCalls` and `fetchWindows`.
- `tokens.json`: `quote` and `tokens`, capital letters and digits. Each token's symbol is the token then the quote, such as `UNIUSDT`.
- `.env.example`: the warehouse settings, the settings above, `PUSHGATEWAY_URL` and `LOG_LEVEL`.

## Invariants

- The call id is `<symbol>:<interval>:<start_time>` (`src/candles.ts:callId`). The record id is `<symbol>:<interval>:<open_time>`, so a rerun replaces a candle.
- Each record's `data` holds `symbol`, `base_asset`, `quote_asset`, `interval`, `open_time`, `open`, `high`, `low`, `close`, `volume`, `close_time`, `quote_volume`, `trades`, `taker_buy_base_volume` and `taker_buy_quote_volume`, as Binance sends them.
- `fetchWindows` reads the clock before each call and keeps only candles whose `close_time` is before it, so no open candle loads.
- Every call that succeeds is listed in `succeededCallIds`, so a window with no closed candles still clears its dead letter.
- A ban (HTTP 418) fails the run, since more calls lengthen it. An unknown market fails the run and names the token. Any other failed call waits in `_dead_letters`.
- `firstOpenTime` finds each market's first candle at or after `START_TIME`, and windows start there, so none falls before a listing and `3d` and `1w` windows stay on Binance's grid. If Binance returns no candle at or after `START_TIME`, the run fails. If the lookup fails for another reason, it warns and the windows start at `START_TIME`.
- Weight: the client reads `x-mbx-used-weight-1m` from each reply and waits once it reaches `WEIGHT_BUDGET` (5000) of Binance's 6000. `BINANCE_MAX_CONCURRENCY` is capped at 100 so one group of weight-2 calls fits in the gap.
- Each market's progress is a checkpoint keyed by `historyKey` over the whole `BINANCE_API_URL`, market, interval and `START_TIME`, with `listingConfirmed` added. A run resumes unfinished history, revisits the last `HISTORY_OVERLAP_DAYS`, and sweeps all of it every `HISTORY_REFRESH_DAYS` or when `HISTORY_FULL_REFRESH=1`.
- `callBatches` sends retried calls before fresh ones, except a retry that the fresh plan already covers (`isFresh`), which goes out once as a fresh call.
- `tokens.json` is read inside `extract` with `readJson`, and `parseTokens` fails the run on a bad file.

## Side Effects

- HTTP GETs to `BINANCE_API_URL` through `observedFetch`, each with a 30-second timeout (`TIMEOUT_MS`). Waits for weight go through `observeDelay`.
- `runSource` writes the records to `raw.binance_candles`, failed calls to `raw._dead_letters`, one row per run to `raw._ingestion_inputs`, progress to `raw._checkpoints`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set, and logs through the pino `logger`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/binance-candles test`
- Run: `pnpm -C ingestion typecheck`
