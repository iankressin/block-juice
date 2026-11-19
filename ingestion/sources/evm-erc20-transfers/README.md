# evm-erc20-transfers

## Overview

A stream source that reads the ERC-20 Transfer logs of the listed tokens on one EVM chain from Portal, optionally only those into or out of listed wallets. Each folder in `chains/<chain>/` is a source named for its chain with a cursor of its own, so the `arbitrum`, `base` and `ethereum` folders load `raw.<chain>_erc20_transfers`. dbt reads them through `transformation/models/staging/<chain>/stg_<chain>__erc20_transfers.sql`.

## Interface

- `src/source.ts:forChain(chain)`: the `StreamSource<TransfersEnv>` for one chain, with `name` the chain, `table` `erc20_transfers` and `coverage` `{ filters: ["tokens", "wallets"], unrestricted: ["wallets"] }`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:TransfersEnv`: `PORTAL_URL` (required), `PORTAL_API_KEY` (optional), `START_BLOCK` (required) and `END_BLOCK` (optional, for a short check window).
- `src/index.ts`: runs `forChain(chainName.parse(process.env.CHAIN))` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=arbitrum pnpm ingest`. A missing or bad `CHAIN` throws before `runSource` starts, so the run logs no fatal line, pushes no metrics and writes no `ops.ingestion_runs` row.
- `chains/<chain>/addresses.json`: `tokens`, required, and `wallets`, optional. `arbitrum` and `base` list tokens only; `ethereum` lists both.
- `chains/<chain>/.env.example`: `PORTAL_URL` and `START_BLOCK`, and a commented `END_BLOCK` for `ethereum`.
- `.env.example`: the warehouse settings, `PORTAL_API_KEY`, `PUSHGATEWAY_URL`, `LOG_LEVEL` and `MAX_BLOCKS_PER_RUN`.
- The event: `commonAbis.erc20.events.Transfer` from `@subsquid/pipes/evm`.
- `package.json`: `@ingestion/lib`, `@subsquid/pipes` 1.0.0-beta.11 and `zod`.

## Invariants

- Each record is one log. Its id and `callId` are `<block>:<logIndex>` (`src/source.ts:toRecord`), so a rerun replaces it.
- Each record's `data` holds `block_number`, `timestamp`, `tx_hash`, `log_index`, `token` (the emitting contract), `from`, `to` and `value` (a decimal string).
- The stream reads only logs from the listed tokens.
- With `wallets`, two decoders read transfers into (`to`) and out of (`from`) the wallets, one per filter, since Pipes refuses two filters on one event in one decoder. A transfer between two listed wallets comes out of both under the same id, so the warehouse keeps one record.
- Without `wallets`, one decoder reads every transfer of the tokens. An empty `wallets` list fails the run; leave the key out to read every transfer.
- The range runs from `START_BLOCK` to `END_BLOCK` or `finalizedHead(portal)`, whichever comes first, read when the run starts.
- `addresses.json` is read inside `stream` with `readJson`. `validateEthAddressList` rejects a bad address, and wallets are lowercased.
- A stream source has no dead letters. An error fails the run, and the next run resumes after the last batch that committed.

## Side Effects

- Streams blocks from `PORTAL_URL` through `portalClient` and `evmPortalStream`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.<chain>_erc20_transfers`, the stream's configuration to `raw._source_configurations`, the blocks it covered to `raw._coverage`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`. Pipes keeps the cursor in `raw._sync`, as `<chain>_erc20_transfers` for the first configuration. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- Pushes run metrics to `PUSHGATEWAY_URL` when set, and logs through the pino `logger`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-erc20-transfers test`
- Run: `pnpm -C ingestion typecheck`
