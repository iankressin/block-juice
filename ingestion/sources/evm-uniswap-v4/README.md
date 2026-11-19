# evm-uniswap-v4

## Overview

A stream source that loads the Uniswap v4 logs of the tokens listed in `addresses.json`, as emitted: each PoolManager `Initialize` that names a token, from `POOLS_START_BLOCK`, and each `Swap` of those pools, from `START_BLOCK`. It also loads the transaction behind each of those logs as a record of its own. Each folder in `chains/<chain>/` is a source named for its chain, so the `ethereum` folder loads `raw.ethereum_uniswap_v4`. dbt reads it through `transformation/models/staging/ethereum/stg_ethereum__uniswap_v4.sql` and `stg_ethereum__uniswap_v4_transactions.sql`. The ABI comes from `catalog/protocols/uniswap/abis/v4-pool-manager.json`.

v4 has no pool contracts: the one PoolManager creates every pool and emits every pool's `Swap`, naming the pool by its id. Pipes' factory pattern follows contracts by address, so this source does the same by pool id: it reads every PoolManager `Swap` and keeps those of pools it has seen created.

## Interface

- `src/source.ts:forChain(chain)`: the `StreamSource<PoolManagerSourceEnv>` for one chain, with `name` the chain and `table` `uniswap_v4`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:PoolManagerSourceEnv`: `PORTAL_URL`, `PORTAL_API_KEY` (optional), `POOLS_START_BLOCK` (default: the PoolManager's deploy block), `START_BLOCK`, `END_BLOCK` (optional), `FACTORY_DB` (default `chains/<chain>/factory.sqlite`).
- `src/source.ts:POOL_MANAGERS` (not exported): each chain's PoolManager address and deploy block, from `catalog/protocols/uniswap/protocol.yaml`. Only `ethereum` is listed.
- `src/index.ts`: runs `forChain(process.env.CHAIN)` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=ethereum pnpm ingest`.
- `chains/<chain>/addresses.json`: `tokens`, a list of token addresses. `chains/ethereum/.env.example` sets `PORTAL_URL`, `POOLS_START_BLOCK`, `START_BLOCK` and `FACTORY_DB`.

## Invariants

- `forChain` throws for a chain missing from `POOL_MANAGERS`.
- The env check refuses a `POOLS_START_BLOCK` after `START_BLOCK`, since the Swaps of pools created between them would be lost.
- A pool holds a token as `currency0` or `currency1`, so each side has its own `Initialize` decoder (Pipes refuses two filters on the same event in one decoder).
- The store at `FACTORY_DB` keeps the ids of the pools found so far, saved by `transform` with `store.save`, and goes with the cursor. `factoryCachePath` keys it by `START_BLOCK`, `POOLS_START_BLOCK`, `PORTAL_URL`, the token list and `SOURCE_BACKFILL_ID`: the first configuration to run keeps the bare `FACTORY_DB` path, and any other, or any run with `SOURCE_BACKFILL_ID` set, uses `<FACTORY_DB>.<hash>`. The `start` hook throws when the store file is new but the cursor has moved; set a new `SOURCE_BACKFILL_ID` to rebuild. On start it loads only the pools of the tokens listed now (`store.all`).
- A `Swap` is kept only when its `id` is a pool in that set. Only the transactions of kept logs are written.
- The range ends at `END_BLOCK` or Portal's finalized head at the start of the run, whichever comes first.
- A log record has id `<block>:<logIndex>` and `data` with `kind: "log"`, `event`, `block_number`, `timestamp`, `tx_hash`, `log_index`, `contract` and `args`. A transaction record has id `tx:<hash>` and `data` with `kind: "transaction"`, `block_number`, `hash` and `from`.
- `coverage.filters` is `["tokens"]`, with `POOLS_START_BLOCK` defaulting to the PoolManager's deploy block. A changed filter list, `START_BLOCK` or `POOLS_START_BLOCK`, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `POOLS_START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- An error fails the run, and the next run resumes after the last batch that committed. The source has no dead letters.

## Side Effects

- Streams from Portal at `PORTAL_URL`, sending `PORTAL_API_KEY` when set. The `Swap` decoder reads every PoolManager `Swap` in the range, not only the listed tokens'.
- Reads and writes the SQLite file at `FACTORY_DB`, or `<FACTORY_DB>.<hash>` for a later configuration, relative to the package. The first run also writes the sidecar `<FACTORY_DB>.identity`, which holds that first configuration's hash (`ingestion/lib/src/factory-cache.ts:factoryCachePath`). Git ignores `chains/*/factory.sqlite*`.
- `runSource` writes the records to `raw.<chain>_uniswap_v4` (`id`, `data`, `_loaded_at`), records each configuration in `raw._source_configurations` and the blocks it loaded in `raw._coverage`, Pipes keeps the cursor in `raw._sync`, keyed by the raw table and its configuration generation (`ingestion/lib/src/warehouse/stream.ts:pipesTarget`), and the run goes in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-uniswap-v4 test`
- Run: `pnpm -C ingestion typecheck`
