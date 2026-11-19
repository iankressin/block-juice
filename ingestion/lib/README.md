# @ingestion/lib

## Overview

The shared code every source imports: the Source contract, `runSource`, settings, JSON inputs, the Portal client, call helpers, logging and transport metrics. Chain code lives under `@ingestion/lib/evm`, `/solana` and `/bitcoin`. `package.json` exports the `.ts` files directly, so there is no build step, and maps `#src/*` to `./src/*`.

Adding a source never changes this package (`ingestion/CLAUDE.md`).

## Interface

Areas, each with its own contract:

- [`src/run/`](./src/run/README.md): `runSource`, the run log row and the Pushgateway gauges.
- [`src/warehouse/`](./src/warehouse/README.md): every Postgres write, dead letters, coverage and the Pipes target.
- [`src/evm/`](./src/evm/README.md): `@ingestion/lib/evm`, EVM addresses, settings and the viem client.
- [`src/solana/`](./src/solana/README.md): `@ingestion/lib/solana`, Solana addresses, settings and the RPC client.
- [`src/bitcoin/`](./src/bitcoin/README.md): `@ingestion/lib/bitcoin`, Bitcoin addresses, settings and the `scantxoutset` client.

`src/index.ts` exports the rest:

- Types (`src/source.ts`):
  - `RawRecord`: `id`, `callId`, `data`.
  - `Failed<C>`: `id`, `call`, `error`.
  - `Checkpoint`: `key`, `value`.
  - `Batch<C>`: `records`, `failed`, and optional `succeededCallIds`, `callsCompleted`, `checkpoints`.
  - `ExtractionContext<C>`: optional `retryPages`, `getCheckpoint`.
  - `StreamRecords`: `RawRecord[]`, or named lists of them that load together.
  - `Source<E, C>`: `name`, `table`, `env`, `call`, `extract(env, retry, context?)`, optional `retryMode: "paged"`.
  - `StreamSource<E>`: `name`, `table`, `env`, `stream(env)`, optional `coverage` (`filters`, `unrestricted`, `caseSensitive`, `defaults`, `defaultPortalUrl`) and `maxBlocksPerRun`.
- `runSource` (`src/run/index.ts`).
- `portalClient(url, apiKey?)` and `finalizedHead(portal)` (`src/portal.ts`).
- `loadEnv(schema)` (`src/env.ts`).
- `readJson(path)` (`src/json.ts`).
- `settleCalls(calls, id, read, rowId?)`, `describeError`, `uniqueBy`, `chunk` (`src/calls.ts`).
- `batches(items, size = 100)`, `callBatches(fresh, retry, id, isFresh, context?, size = 100, retryFirst = false)`, `retryPages(retry, context?)` (`src/batches.ts`).
- `DAY_MS`, `historyKey`, `historyState`, `historyPlan`, `HistorySettings` (`src/history.ts`), for call sources that read history in time windows. `HistorySettings` holds `HISTORY_OVERLAP_DAYS` (default 3), `HISTORY_REFRESH_DAYS` (default 7) and `HISTORY_FULL_REFRESH` (`"0"` or `"1"`).
- `factoryCachePath(path, settings, addresses)` (`src/factory-cache.ts`).
- `logger` and `Logger` (`src/logger.ts`), with level from `LOG_LEVEL`.
- `observedFetch` and `observeDelay` (`src/transport-metrics.ts`).

Internal to the package: `createLimiter` (`src/concurrency.ts`), `captureJsonReads` (`src/json.ts`), `localEndpoints` (`src/env.ts`), and `withTransportMetrics`, `transportSnapshot`, `observeRequest`, `observeQueue` (`src/transport-metrics.ts`).

## Invariants

- A source's `name` and `table` must equal its dbt source and table names, since Dagster keys the asset by that pair (`src/source.ts:SourceBase`).
- A failed call's `id` is the `callId` of the record it would have produced; that record clears the dead letter. A call with no records clears it only through `succeededCallIds` (`src/source.ts:Source`).
- A stream must end: give its range a `to`, such as `finalizedHead` at the start (`src/source.ts:StreamSource`).
- `loadEnv` takes a value from the environment first, then `chains/<CHAIN>/.env`, `chains/<CHAIN>/.env.example` and the working directory's `.env`. An empty value counts as unset. Only the environment sets `CHAIN`; a `CHAIN` in a file is dropped. A schema that fails throws `Invalid environment:` with each issue.
- When a schema has `EVM_RPC_URL` or `DSHACKLE_URL` and the value is unset, `localEndpoints` fills in a local proxy URL. It fills `EVM_RPC_URL` only when `CHAIN` is `ethereum`, `arbitrum`, `base` or `polygon`. The port comes from `ERPC_PORT` or `DSHACKLE_PORT`, in the environment or the repo root `.env`, and must be 1 to 65535. A set URL always wins.
- `readJson` reads a path from the working directory, which is the package folder when a source runs. Invalid JSON throws `<path> is not valid JSON: ...`. Inside a run it records each file version's SHA-256 and size, up to 16 versions per file and 128 files, and marks the evidence truncated past that.
- `settleCalls` makes each distinct call once and starts at most `CALL_BATCH_SIZE` (100) reads in the same tick, so RPC clients can batch them. A resolved read becomes a record, a rejected one a `Failed` with `describeError`.
- `batches` and `callBatches` throw unless `size` is a positive safe integer. `callBatches` yields fresh calls, then retries (retries first with `retryFirst`), drops retries that `isFresh` claims, and removes duplicate ids within each retry page.
- `portalClient` reads finalized blocks only, retries 10 times (about two minutes), sends `x-api-key` when given a key, and asks for gzip only, since Node's zstd decoder stops after the first frame of a Portal stream. `finalizedHead` throws when Portal reports no finalized head.
- `historyPlan` resumes from the saved `next`, and an ordinary run goes back over the last `HISTORY_OVERLAP_DAYS`. It sweeps from `origin` when nothing is saved, `HISTORY_FULL_REFRESH` is `"1"`, or `HISTORY_REFRESH_DAYS` have passed. An unfinished sweep resumes from the saved `refreshNext`, unless `HISTORY_FULL_REFRESH` is `"1"`. Its `checkpoint(next)` returns a `Checkpoint` for `Batch.checkpoints`. `historyState` returns undefined unless `origin`, `next` and `refreshedAt` are whole numbers of at least 0 and any `refreshNext` is at least `origin`.
- `factoryCachePath` returns `path` when `SOURCE_BACKFILL_ID` is unset and the settings and addresses hash to the value first written to `<path>.identity`. Otherwise it returns `<path>.<first 24 hex of the hash>`. It writes no raw settings or URLs.
- `logger` writes JSON lines to stdout, which Dagster reads as log events, or readable lines on a TTY. A bad `LOG_LEVEL` warns and uses `info`.
- `createLimiter(max)` runs at most `max` tasks at once; a finished task hands its slot to the next one waiting.
- Transport metrics are per run (`AsyncLocalStorage`), with no endpoint labels and no kept requests. `observedFetch` counts a non-OK response as failed and still returns it.

## Side Effects

- `loadEnv` reads `.env` files and writes their values into `process.env` without overriding set ones. It also reads the repo root `.env` for proxy ports. `src/logger.ts` calls it at import.
- `readJson` reads a file from disk.
- `factoryCachePath` creates the cache's folder and its `.identity` file when missing.
- `portalClient` and `finalizedHead` send HTTP requests to Portal. `observedFetch` sends one `fetch`.
- `logger` writes to stdout.
- `runSource` and the warehouse write to Postgres and the Pushgateway; see their contracts.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/lib test`
- Run: `pnpm -C ingestion typecheck`
- Under a Node major other than 24, prefix both with `mise exec --`.
