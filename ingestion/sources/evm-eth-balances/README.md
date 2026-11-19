# evm-eth-balances

## Overview

A call source that reads the native balance of each listed wallet on one EVM chain at one block. Each folder in `chains/<chain>/` is a source named for its chain, so the `ethereum` folder loads `raw.ethereum_eth_balances`. dbt reads it through `transformation/models/staging/ethereum/stg_ethereum__eth_balances.sql`.

## Interface

- `src/source.ts:forChain(chain)`: the `Source<EvmEnv, BalanceCall>` for one chain, with `name` the chain and `table` `eth_balances`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/balances.ts:balanceCallSchema` and `BalanceCall`: a call is `{ kind: "eth_balance", block, wallet }`.
- `src/balances.ts:balanceCallsAt(block, wallets)`: one call per wallet at `block`, wallets lowercased.
- `src/balances.ts:fetchBalances(client, calls)`: makes the calls through `settleCalls` and returns a batch.
- `src/index.ts`: runs `forChain(process.env.CHAIN)` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=ethereum pnpm ingest`.
- `chains/<chain>/addresses.json`: `wallets`, a list of EVM addresses. Only `chains/ethereum/` exists.
- Settings (`evmEnv` in `ingestion/lib/src/evm/env.ts`): `BLOCK_NUMBER` (a number, or `latest`, `safe` or `finalized`), `EVM_RPC_URL`, `RPC_BATCH_SIZE` (default 100), `RPC_MAX_CONCURRENCY` (default 16). `chains/<chain>/.env.example` sets `EVM_RPC_URL` and `RPC_BATCH_SIZE`; the package `.env.example` sets the shared ones.

## Invariants

- `connect` (`ingestion/lib/src/evm/client.ts`) turns a `BLOCK_NUMBER` tag into one block number at the start of the run, so every fresh call in the run reads the same block.
- A call carries its block, so a dead letter retried in a later run reads the block it missed, not the new one.
- The call id and the record id are both `<block>:<wallet>` (`src/balances.ts:callId`), so a rerun at the same block replaces the record, and the record clears the dead letter of its call.
- `callBatches` skips a retried call that equals a fresh one (same block, wallet still listed), so no call goes out twice in one run.
- Each record's `data` holds `block_number`, `wallet` (lowercased) and `balance` (wei, from `getBalance`). Units and sums are dbt's.
- `addresses.json` is read inside `extract` with `readJson`, so a bad file fails the run with a logged reason. `validateEthAddressList` rejects a bad address.
- The RPC must serve past blocks (an archive node) when `BLOCK_NUMBER` or a retry names an old block.

## Side Effects

- JSON-RPC calls to `EVM_RPC_URL`: `eth_getBalance` per call, and `eth_getBlockByNumber` when `BLOCK_NUMBER` is a tag. viem sends up to `RPC_BATCH_SIZE` calls per HTTP POST and retries each 5 times (`createEvmClient`).
- `runSource` writes the records to `raw.<chain>_eth_balances` (`id`, `data`, `_loaded_at`), keeps failed calls in `raw._dead_letters`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-eth-balances test`
- Run: `pnpm -C ingestion typecheck`
