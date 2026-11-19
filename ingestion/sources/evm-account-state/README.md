# evm-account-state

## Overview

A call source that reads the balance, nonce and code of each listed wallet on one EVM chain, at `BLOCK_NUMBER` and at each block in `ALSO_AT_BLOCKS`. Each folder in `chains/<chain>/` is a source named for its chain, so the `ethereum` folder loads `raw.ethereum_account_state`. dbt reads it through `transformation/models/staging/ethereum/stg_ethereum__account_state.sql`.

## Interface

- `src/source.ts:forChain(chain)`: the `Source<AccountStateEnv, StateCall>` for one chain, with `name` the chain, `table` `account_state` and `retryMode` `paged`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:AccountStateEnv`: `evmEnv` (`ingestion/lib/src/evm/env.ts`: `BLOCK_NUMBER`, `EVM_RPC_URL`, `RPC_BATCH_SIZE`, `RPC_MAX_CONCURRENCY`) plus `ALSO_AT_BLOCKS`, optional block numbers separated by commas.
- `src/source.ts:KINDS`: `balance`, `nonce` and `code`, one call each per address and block.
- `src/source.ts:stateCallSchema` and `StateCall`: a call is `{ kind, block, address }`.
- `src/source.ts:stateCallsAt(block, addresses)`: the three calls for each address at `block`, addresses lowercased.
- `src/source.ts:fetchState(client, calls)`: makes the calls through `settleCalls` and returns a batch.
- `src/index.ts`: runs `forChain(chainName.parse(process.env.CHAIN))` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=ethereum pnpm ingest`. A missing or bad `CHAIN` throws before `runSource` starts, so the run logs no fatal line, pushes no metrics and writes no `ops.ingestion_runs` row.
- `chains/<chain>/addresses.json`: `wallets`, a list of EVM addresses. Only `chains/ethereum/` exists.
- `chains/<chain>/.env.example`: `EVM_RPC_URL` and `ALSO_AT_BLOCKS`. Left empty, `EVM_RPC_URL` becomes a local eRPC URL from the root `ERPC_PORT` (`ingestion/lib/src/env.ts`).
- `.env.example`: the warehouse settings, `BLOCK_NUMBER` (`finalized`), `RPC_BATCH_SIZE` (10), `RPC_MAX_CONCURRENCY` (2), `PUSHGATEWAY_URL` and `LOG_LEVEL`.
- `package.json`: `@ingestion/lib`, `viem` and `zod`.

## Invariants

- `connect` turns a `BLOCK_NUMBER` tag into one block number at the start of the run, so every address in the run is read at the same block. The run reads that block and each in `ALSO_AT_BLOCKS`, once each.
- A call carries its block, so a dead letter retried in a later run reads the block it missed.
- The call id and the record id are both `<block>:<kind>:<address>` (`src/source.ts:callId`), so a reading already loaded is read again and replaces itself.
- Each record's `data` holds `kind`, `block_number` and `address`, plus `balance` (wei as a decimal string, from `eth_getBalance`), `nonce` (from `eth_getTransactionCount`) or `code` (from `eth_getCode`, `"0x"` for an address with none).
- `callBatches` skips a retried call that equals a fresh one, so no call goes out twice in one run. Each group holds at most `min(100, RPC_BATCH_SIZE * RPC_MAX_CONCURRENCY * 10)` calls.
- `addresses.json` is read inside `extract` with `readJson`. A file with no wallets fails the run, and `validateEthAddressList` rejects a bad address.
- The RPC must be an archive node when `ALSO_AT_BLOCKS`, a past `BLOCK_NUMBER` or a retry names an old block.

## Side Effects

- JSON-RPC calls to `EVM_RPC_URL`: `eth_getBalance`, `eth_getTransactionCount` and `eth_getCode` per address and block, and one block lookup when `BLOCK_NUMBER` is a tag.
- `runSource` writes the records to `raw.<chain>_account_state`, failed calls to `raw._dead_letters`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-account-state test`
- Run: `pnpm -C ingestion typecheck`
