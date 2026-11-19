# hypercore-fills

## Overview

A stream source that loads every HyperCore fill of the users and coins listed in `addresses.json`, from Portal's `hyperliquid-fills` dataset. It loads into `raw.hypercore_fills`, which dbt reads through `transformation/models/staging/hypercore/stg_hypercore__fills.sql`.

## Interface

- `src/source.ts:source`: the `StreamSource<HypercoreFillsEnv>` with `name` `hypercore` and `table` `fills`.
- `src/source.ts:HypercoreFillsEnv`: `PORTAL_URL` (default the `hyperliquid-fills` dataset), `PORTAL_API_KEY` (optional), `START_BLOCK`, `END_BLOCK` (optional).
- `src/index.ts`: runs `source` through `runSource`.
- `addresses.json`: `users`, a list of addresses, and `coins`, a list of coin names. Each key is optional, but at least one must be present.
- `.env.example` sets `PORTAL_URL` and `START_BLOCK`.
- `hyperliquidFillsPortalStream` takes a `PortalClient` as `portal` only through the workspace's pnpm patch to Pipes (`ingestion/pnpm-workspace.yaml`).

## Invariants

- `src/source.ts:fillRequest` fails the run when both keys are missing, since one busy coin fills hundreds of thousands of times a day. `listed` fails it when a present key is empty or holds a value that is not a non-empty string, and `validateEthAddressList` fails it when a listed user is not a valid EVM address. A missing key reads every value.
- Portal ANDs the fields of one filter, so with both keys the stream returns the fills of the listed users in the listed coins.
- Users go out lowercased, as Portal returns `user`. Coin names are case-sensitive (`BTC`, `@107`, `xyz:TSLA`) and go out as given.
- `fillFields` asks for every fill field. It is typed over the SDK's `api.FillFields`, so a field a Pipes upgrade adds fails the typecheck until it is listed.
- Each record is one fill: id `<block>:<fillIndex>`, and `data` with `block_number`, `timestamp` and `fill` as Portal sends it. Prices, sizes and fees are JSON numbers, and `side` is `B` or `A`. Pipes drops a field Portal sends as null, and rejects an id such as `tid` or `oid` past 2^53 rather than load a rounded one.
- The range runs from `START_BLOCK` to `END_BLOCK` or Portal's finalized head at the start of the run, whichever comes first.
- `coverage` lists `users` and `coins` as both filters and unrestricted, `coins` as case-sensitive, and `defaultPortalUrl` as the default dataset. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- An error fails the run, and the next run resumes after the last batch that committed. The source has no dead letters.

## Side Effects

- Streams from Portal at `PORTAL_URL`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.hypercore_fills` (`id`, `data`, `_loaded_at`), records each configuration in `raw._source_configurations` and the blocks it loaded in `raw._coverage`, Pipes keeps the cursor in `raw._sync`, keyed by the raw table and its configuration generation (`ingestion/lib/src/warehouse/stream.ts:pipesTarget`), and the run goes in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/hypercore-fills test`
- Run: `pnpm -C ingestion typecheck`
