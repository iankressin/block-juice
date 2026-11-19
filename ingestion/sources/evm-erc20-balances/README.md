# evm-erc20-balances

## Overview

A call source that reads `balanceOf` for every listed token and wallet on one EVM chain at one block. Each folder in `chains/<chain>/` is a source named for its chain, so the `ethereum` folder loads `raw.ethereum_erc20_balances`. dbt reads it through `transformation/models/staging/ethereum/stg_ethereum__erc20_balances.sql`.

## Interface

- `src/source.ts:forChain(chain)`: the `Source<EvmEnv, BalanceCall>` for one chain, with `name` the chain, `table` `erc20_balances` and `retryMode` `paged`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/balances.ts:balanceCallSchema` and `BalanceCall`: a call is `{ kind: "erc20_balance", block, token, wallet }`.
- `src/balances.ts:balanceCallsAt(block, wallets, tokens)`: one call per token and wallet at `block`, addresses lowercased.
- `src/balances.ts:fetchBalances(client, calls)`: makes the calls through `settleCalls` and returns a batch.
- `src/index.ts`: runs `forChain(chainName.parse(process.env.CHAIN))` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=ethereum pnpm ingest`. A missing or bad `CHAIN` throws before `runSource` starts, so the run logs no fatal line, pushes no metrics and writes no `ops.ingestion_runs` row.
- `chains/<chain>/addresses.json`: `wallets` and `tokens`, lists of EVM addresses. Only `chains/ethereum/` exists.
- Settings (`evmEnv` in `ingestion/lib/src/evm/env.ts`): `BLOCK_NUMBER`, `EVM_RPC_URL`, `RPC_BATCH_SIZE` (default 100), `RPC_MAX_CONCURRENCY` (default 16). `chains/<chain>/.env.example` sets `EVM_RPC_URL` and `RPC_BATCH_SIZE`; the package `.env.example` sets `BLOCK_NUMBER` (`finalized`), the warehouse settings, `PUSHGATEWAY_URL` and `LOG_LEVEL`.
- `package.json`: `@ingestion/lib`, `viem` and `zod`.

## Invariants

- `connect` turns a `BLOCK_NUMBER` tag into one block number at the start of the run, so every call in the run reads the same block.
- A call carries its block, so a dead letter retried in a later run reads the block it missed.
- The call id and the record id are both `<block>:<token>:<wallet>` (`src/balances.ts:callId`), so a rerun at the same block replaces the record and clears the dead letter of its call.
- Each record's `data` holds `block_number`, `token`, `wallet` and `balance`, the raw `balanceOf` reply as a decimal string. Decimals and sums are dbt's.
- A revert or an empty reply at the pinned block (viem's `RawContractError` or `ContractFunctionZeroDataError`) gives the same answer on every retry, so it becomes a record with `balance: null`, not a failed call. Any other error fails the call.
- The client merges reads at the same block into one Multicall3 call (`createEvmClient` in `ingestion/lib/src/evm/client.ts`).
- `callBatches` skips a retried call that equals a fresh one, so no call goes out twice in one run.
- `addresses.json` is read inside `extract` with `readJson`, and `validateEthAddressList` rejects a bad address.
- The RPC must be an archive node when `BLOCK_NUMBER` or a retry names an old block.

## Side Effects

- JSON-RPC `eth_call`s to `EVM_RPC_URL`, batched through Multicall3, and one block lookup when `BLOCK_NUMBER` is a tag.
- `runSource` writes the records to `raw.<chain>_erc20_balances`, failed calls to `raw._dead_letters`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-erc20-balances test`
- Run: `pnpm -C ingestion typecheck`
