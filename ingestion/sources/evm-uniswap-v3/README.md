# evm-uniswap-v3

## Overview

A stream source that loads the Uniswap v3 logs of the tokens listed in `addresses.json`, as emitted: each `PoolCreated` that names a token, from `POOLS_START_BLOCK`, and each `Swap` of those pools, from `START_BLOCK`. It also loads the transaction behind each of those logs as a record of its own. Each folder in `chains/<chain>/` is a source named for its chain, so the `ethereum` folder loads `raw.ethereum_uniswap_v3`. dbt reads it through `transformation/models/staging/ethereum/stg_ethereum__uniswap_v3.sql` and `stg_ethereum__uniswap_v3_transactions.sql`. Which token a Swap bought is dbt's to work out. The ABIs come from `catalog/protocols/uniswap/abis/v3-factory.json` and `v3-pool.json`.

## Interface

- `src/source.ts:forChain(chain)`: the `StreamSource<FactorySourceEnv>` for one chain, with `name` the chain and `table` `uniswap_v3`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:FactorySourceEnv`: `PORTAL_URL`, `PORTAL_API_KEY` (optional), `POOLS_START_BLOCK` (default: the factory's deploy block), `START_BLOCK`, `END_BLOCK` (optional), `FACTORY_DB` (default `chains/<chain>/factory.sqlite`).
- `src/source.ts:FACTORIES` (not exported): each chain's factory address and deploy block, from `catalog/protocols/uniswap/protocol.yaml`. Only `ethereum` is listed.
- `src/index.ts`: runs `forChain(process.env.CHAIN)` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=ethereum pnpm ingest`.
- `chains/<chain>/addresses.json`: `tokens`, a list of token addresses. `chains/ethereum/.env.example` sets `PORTAL_URL`, `POOLS_START_BLOCK`, `START_BLOCK` and `FACTORY_DB`.

## Invariants

- `forChain` throws for a chain missing from `FACTORIES`.
- The env check refuses a `POOLS_START_BLOCK` after `START_BLOCK`, since the Swaps of pools created between them would be lost. `POOLS_START_BLOCK` must reach back to the first pool of every listed token, since old pools still trade.
- Pipes' `contractFactory` follows the pools. A pool holds a token as `token0` or `token1`, so each side has its own decoders (Pipes refuses two filters on the same event in one decoder).
- The factory store `FACTORY_DB` goes with the cursor. `factoryCachePath` keys it by `START_BLOCK`, `POOLS_START_BLOCK`, `PORTAL_URL`, the token list and `SOURCE_BACKFILL_ID`: the first configuration to run keeps the bare `FACTORY_DB` path, and any other, or any run with `SOURCE_BACKFILL_ID` set, uses `<FACTORY_DB>.<hash>`. The `start` hook throws when the store file is new but the cursor has moved, since the pools created before the cursor would be gone; set a new `SOURCE_BACKFILL_ID` to rebuild. The store opens, and so creates its file, only after that check passes.
- The range ends at `END_BLOCK` or Portal's finalized head at the start of the run, whichever comes first.
- A log record has id `<block>:<logIndex>` and `data` with `kind: "log"`, `event`, `block_number`, `timestamp`, `tx_hash`, `log_index`, `contract` and `args`. A transaction record has id `tx:<hash>` and `data` with `kind: "transaction"`, `block_number`, `hash` and `from`. Only the transactions of kept logs are written.
- `coverage.filters` is `["tokens"]`, with `POOLS_START_BLOCK` defaulting to the factory's deploy block. A changed filter list, `START_BLOCK` or `POOLS_START_BLOCK`, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `POOLS_START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- An error fails the run, and the next run resumes after the last batch that committed. The source has no dead letters.

## Side Effects

- Streams from Portal at `PORTAL_URL`, sending `PORTAL_API_KEY` when set.
- Reads and writes the SQLite file at `FACTORY_DB`, or `<FACTORY_DB>.<hash>` for a later configuration, relative to the package. The first run also writes the sidecar `<FACTORY_DB>.identity`, which holds that first configuration's hash (`ingestion/lib/src/factory-cache.ts:factoryCachePath`). Git ignores `chains/*/factory.sqlite*`.
- `runSource` writes the records to `raw.<chain>_uniswap_v3` (`id`, `data`, `_loaded_at`), records each configuration in `raw._source_configurations` and the blocks it loaded in `raw._coverage`, Pipes keeps the cursor in `raw._sync`, keyed by the raw table and its configuration generation (`ingestion/lib/src/warehouse/stream.ts:pipesTarget`), and the run goes in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-uniswap-v3 test`
- Run: `pnpm -C ingestion typecheck`
