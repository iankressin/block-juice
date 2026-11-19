# evm-chainlink-price-feeds

## Overview

A stream source that reads the `AnswerUpdated` logs of the listed Chainlink aggregators on one EVM chain from Portal. Each folder in `chains/<chain>/` is a source named for its chain, so the `arbitrum`, `base` and `ethereum` folders load `raw.<chain>_chainlink_price_feeds`. dbt reads them through `transformation/models/staging/<chain>/stg_<chain>__chainlink_price_feeds.sql`.

## Interface

- `src/source.ts:forChain(chain)`: the `StreamSource<PriceFeedsEnv>` for one chain, with `name` the chain, `table` `chainlink_price_feeds` and `coverage` `{ filters: ["aggregators"], unrestricted: [] }`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:PriceFeedsEnv`: `PORTAL_URL` (required, no default), `PORTAL_API_KEY` (optional), `START_BLOCK` (required) and `END_BLOCK` (optional, for a short check window).
- `src/index.ts`: runs `forChain(chainName.parse(process.env.CHAIN))` through `runSource`. A missing or bad `CHAIN` throws before `runSource` starts, so the run logs no fatal line, pushes no metrics and writes no `ops.ingestion_runs` row.
- `chains/<chain>/addresses.json`: `aggregators`, the aggregator contracts to read.
- `chains/<chain>/.env.example`: `PORTAL_URL`, `START_BLOCK` and a commented `END_BLOCK`.
- `.env.example`: the warehouse settings, `PORTAL_API_KEY`, `PUSHGATEWAY_URL`, `LOG_LEVEL` and `MAX_BLOCKS_PER_RUN`.
- ABI: `catalog/protocols/chainlink/abis/aggregator.json`, for `AnswerUpdated`.
- `package.json`: `@ingestion/lib`, `@subsquid/pipes` 1.0.0-beta.11 and `zod`.

## Invariants

- Each record is one log. Its id and `callId` are `<block>:<logIndex>` (`src/source.ts:logRecord`), so a rerun replaces it.
- Each record's `data` holds `kind: "log"`, `event: "AnswerUpdated"`, `block_number`, `timestamp`, `tx_hash`, `log_index`, `contract` and `args`.
- The stream reads only logs from the listed aggregators. `AnswerUpdated` names no feed, so dbt maps each aggregator to its feed through `transformation/seeds/chainlink_feeds.csv`.
- A file with no aggregators fails the run: the decoder would keep no log, yet the cursor would still move past the blocks it read.
- The range runs from `START_BLOCK` to `END_BLOCK` or `finalizedHead(portal)`, whichever comes first, read when the run starts.
- `addresses.json` is read inside `stream` with `readJson`, and `validateEthAddressList` rejects a bad address.
- A stream source has no dead letters. An error fails the run, and the next run resumes after the last batch that committed.

## Side Effects

- Streams blocks from `PORTAL_URL` through `portalClient` and `evmPortalStream`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.<chain>_chainlink_price_feeds`, the stream's configuration to `raw._source_configurations`, the blocks it covered to `raw._coverage`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`. Pipes keeps the cursor in `raw._sync`, as `<chain>_chainlink_price_feeds` for the first configuration. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- Pushes run metrics to `PUSHGATEWAY_URL` when set, and logs through the pino `logger`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-chainlink-price-feeds test`
- Run: `pnpm -C ingestion typecheck`
