# evm-address-code

## Overview

A call source that reads the code of each listed address on one EVM chain at one block. Each folder in `chains/<chain>/` is a source named for its chain, so the `arbitrum` and `base` folders load `raw.arbitrum_address_code` and `raw.base_address_code`. dbt reads them through `transformation/models/staging/arbitrum/stg_arbitrum__address_code.sql` and `transformation/models/staging/base/stg_base__address_code.sql`. `ingestion/CLAUDE.md` names `src/source.ts` as the shape to copy for a call source.

## Interface

- `src/source.ts:forChain(chain)`: the `Source<EvmEnv, CodeCall>` for one chain, with `name` the chain, `table` `address_code` and `retryMode` `paged`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:codeCallSchema` and `CodeCall`: a call is `{ kind: "code", block, address }`.
- `src/source.ts:codeCallsAt(block, addresses)`: one call per address at `block`, addresses lowercased.
- `src/source.ts:fetchCode(client, calls)`: makes the calls through `settleCalls` and returns a batch.
- `src/index.ts`: runs `forChain(chainName.parse(process.env.CHAIN))` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=arbitrum pnpm ingest`. A missing or bad `CHAIN` throws before `runSource` starts, so the run logs no fatal line, pushes no metrics and writes no `ops.ingestion_runs` row.
- `chains/<chain>/addresses.json`: `addresses`, a list of EVM addresses. `chains/arbitrum/` and `chains/base/` exist.
- `chains/<chain>/.env.example`: `EVM_RPC_URL`. Left empty, it becomes a local eRPC URL from the root `ERPC_PORT` (`ingestion/lib/src/env.ts`).
- Settings (`evmEnv` in `ingestion/lib/src/evm/env.ts`): `BLOCK_NUMBER`, `EVM_RPC_URL`, `RPC_BATCH_SIZE`, `RPC_MAX_CONCURRENCY`. The package `.env.example` sets `BLOCK_NUMBER` (`latest`), `RPC_BATCH_SIZE` (10) and `RPC_MAX_CONCURRENCY` (2), with the warehouse settings, `PUSHGATEWAY_URL` and `LOG_LEVEL`.
- `package.json`: `@ingestion/lib`, `viem` and `zod`.

## Invariants

- `connect` turns a `BLOCK_NUMBER` tag into one block number at the start of the run, so every address in the run is read at the same block.
- A call carries its block, so a dead letter retried in a later run reads the block it missed.
- The call id and the record id are both `<block>:<address>` (`src/source.ts:callId`), so a rerun at the same block replaces the record and clears the dead letter of its call.
- Each record's `data` holds `block_number`, `address` (lowercased) and `code` as `eth_getCode` returns it, `"0x"` for an address with none.
- `callBatches` skips a retried call that equals a fresh one, so no call goes out twice in one run.
- `addresses.json` is read inside `extract` with `readJson`, so a bad file fails the run with a logged reason. `validateEthAddressList` rejects a bad address. A file with no `addresses` key fails with a bare TypeError that names neither the file nor the key. An empty list is not checked, so the run makes no fresh calls.

## Side Effects

- JSON-RPC calls to `EVM_RPC_URL`: `eth_getCode` per call, and one block lookup when `BLOCK_NUMBER` is a tag.
- `runSource` writes the records to `raw.<chain>_address_code`, failed calls to `raw._dead_letters`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-address-code test`
- Run: `pnpm -C ingestion typecheck`
