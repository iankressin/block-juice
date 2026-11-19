# polymarket-markets

## Overview

A call source that loads Polymarket's market list from the Gamma API, each market as Gamma sends it. It loads into `raw.polymarket_markets`, which dbt reads through `transformation/models/staging/polymarket/stg_polymarket__markets.sql`. Each run walks the open markets and the closed markets of each UTC end date from its history plan to today, for both market versions. The API's endpoints, limits and fields are in `catalog/vendors/polymarket/`.

## Interface

- `src/source.ts:marketsSource(clock)`: the `Source<GammaEnv, MarketsWalkCall>` with `name` `polymarket` and `table` `markets`. `polymarketMarkets` is the one with `systemClock`.
- `src/source.ts:GammaEnv`: `GAMMA_API_URL` (default Gamma's public URL), `GAMMA_PAGE_SIZE` (1 to 100, default 100), `GAMMA_MAX_CONCURRENCY` (1 to 20, default 6), `GAMMA_END_DATE_FROM` (required ISO date), and the optional `HISTORY_OVERLAP_DAYS`, `HISTORY_REFRESH_DAYS` and `HISTORY_FULL_REFRESH` (`0` or `1`) read by `historyPlan` (`ingestion/lib/src/history.ts`).
- `src/index.ts`: runs `polymarketMarkets` through `runSource`.
- `src/markets.ts:marketsWalkCallSchema` and `MarketsWalkCall`: a call is one walk, `{ kind: "markets_walk", version, closed, end_date_min, end_date_max }`, with `version` `v1` or `v2`.
- `src/markets.ts:callId(call)`: `markets:<version>:open`, `markets:<version>:closed:<YYYY-MM-DD>`, or `markets:<version>:closed:after` for markets that end after today.
- `src/markets.ts:openWalkCalls()`, `closedWalkCalls(version, from, now)` and `walkCalls(from, now)`: build the walks.
- `src/markets.ts:walkMarkets(gamma, calls, { limit, concurrency, onProgress })`: walks each call to its end and yields one batch per round.
- `src/gamma.ts:createGammaClient(url, clock)` and `GammaClient`: `markets(query)` reads one reply of `/markets/keyset`; `waitForRate()` spaces rounds.
- `src/gamma.ts:GammaError`, `Clock`, `systemClock`, `Market`, `MarketsPage` and `MarketsQuery`.

## Invariants

- Open walks run before closed ones, and a closed walk waits until no open walk is active, so a market that closes mid-run is seen open or closed, never missed.
- The open walk has no date filter, so a market with no end date is kept. Each closed walk covers one UTC day with both bounds inclusive, and a last walk covers markets that end after today.
- Only the last reply of a walk gives its records the walk's `callId`; earlier replies use `<callId>#<n>`. A walk that fails partway keeps its dead letter.
- A walk whose reply names as next the cursor it was asked for fails its call. A finished walk's id goes in `succeededCallIds`.
- A record has id `market:<id>` and `data` holding the whole market. A market two walks meet in one round is written once.
- `GammaError.retryable` is true for 429 and 5xx. The client retries those, dropped connections and timeouts after waits of `RETRY_WAITS_MS` (1, 2 and 4 seconds), then fails the call. Any other HTTP error fails it at once. Each fetch times out after `TIMEOUT_MS` (60 seconds).
- A round starts at most once every `ROUND_MS` (1 second) and sends one fetch per active walk, so Gamma sees at most `GAMMA_MAX_CONCURRENCY` fetches a second against its 300 per 10 seconds.
- A reply that does not match the zod `reply` shape fails the call.
- Retried open walks, and retried closed-day walks inside the history plan, are dropped, since the run makes those walks anyway. Failed walks for markets after today fold into the new one, keeping the earliest `end_date_min`.
- Per version, `historyPlan` keyed by `historyKey(["gamma", GAMMA_API_URL, version, origin])` sets the first closed day: it resumes unfinished history, revisits `HISTORY_OVERLAP_DAYS` (default 3) on ordinary runs, and sweeps from `GAMMA_END_DATE_FROM` every `HISTORY_REFRESH_DAYS` (default 7) or when `HISTORY_FULL_REFRESH=1`.
- `retryMode` is `"paged"`: retries arrive through `retryPages(retry, context)`.

## Side Effects

- HTTP GETs to `<GAMMA_API_URL>/markets/keyset` through `observedFetch`. Gamma needs no key.
- Sleeps between rounds and before retries, through `observeDelay`.
- `runSource` writes the records to `raw.polymarket_markets` (`id`, `data`, `_loaded_at`), keeps failed walks in `raw._dead_letters`, saves each version's history plan in `raw._checkpoints` through `onProgress`, and records the run in the run log, `ops.ingestion_runs`.
- Logs each retry at `info` through the pino `logger`, and pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/polymarket-markets test`
- Run: `pnpm -C ingestion typecheck`
