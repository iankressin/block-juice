# evm-op-standard-bridge

## Overview

A stream source that loads the OP Stack L2StandardBridge's `ERC20BridgeInitiated` and `ERC20BridgeFinalized` logs for the tokens listed in `addresses.json`, as emitted. Each folder in `chains/<chain>/` is a source named for its chain, so the `base` folder loads `raw.base_op_standard_bridge`. dbt reads it through `transformation/models/staging/base/stg_base__op_standard_bridge.sql`. The ABI comes from `catalog/protocols/op-standard-bridge/abis/l2-standard-bridge.json`.

## Interface

- `src/source.ts:forChain(chain)`: the `StreamSource<StandardBridgeEnv>` for one chain, with `name` the chain and `table` `op_standard_bridge`.
- `src/source.ts:BRIDGES`: each chain's L2StandardBridge address, from `catalog/protocols/op-standard-bridge/protocol.yaml`. Only `base` is listed.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:StandardBridgeEnv`: `PORTAL_URL`, `PORTAL_API_KEY` (optional), `START_BLOCK`, `END_BLOCK` (optional).
- `src/index.ts`: runs `forChain(process.env.CHAIN)` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=base pnpm ingest`.
- `chains/<chain>/addresses.json`: `tokens`, a list of L2 token addresses. `chains/base/.env.example` sets `PORTAL_URL` and `START_BLOCK`.

## Invariants

- `forChain` throws for a chain missing from `BRIDGES`, naming the catalog file to copy the address from.
- The stream filters on the indexed `localToken` argument, since another token on the chain can name the same remote token.
- Each event has its own `evmEventDecoder`, because Pipes refuses two filters on the same event in one decoder. The legacy `WithdrawalInitiated` and `DepositFinalized` repeat the same values and are not read.
- The range runs from `START_BLOCK` to `END_BLOCK` or Portal's finalized head at the start of the run, whichever comes first.
- Each record is one log: id `<block>:<logIndex>`, and `data` with `kind: "log"`, `event`, `block_number`, `timestamp`, `tx_hash`, `log_index`, `contract` and the decoded `args`.
- `coverage.filters` is `["tokens"]`, with nothing unrestricted: the stream loads only the listed tokens. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- An error fails the run, and the next run resumes after the last batch that committed. The source has no dead letters.

## Side Effects

- Streams from Portal at `PORTAL_URL`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.<chain>_op_standard_bridge` (`id`, `data`, `_loaded_at`), records each configuration in `raw._source_configurations` and the blocks it loaded in `raw._coverage`, Pipes keeps the cursor in `raw._sync`, keyed by the raw table and its configuration generation (`ingestion/lib/src/warehouse/stream.ts:pipesTarget`), and the run goes in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-op-standard-bridge test`
- Run: `pnpm -C ingestion typecheck`
