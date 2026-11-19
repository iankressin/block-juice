# evm-erc20-metadata

## Overview

A call source that reads the `name`, `symbol` and `decimals` of each listed token on one EVM chain at one block. Each folder in `chains/<chain>/` is a source named for its chain, so the `arbitrum`, `base` and `ethereum` folders load `raw.<chain>_erc20_metadata`. dbt reads them through `transformation/models/staging/<chain>/stg_<chain>__erc20_metadata.sql`.

## Interface

- `src/source.ts:forChain(chain)`: the `Source<EvmEnv, MetadataCall>` for one chain, with `name` the chain, `table` `erc20_metadata` and `retryMode` `paged`.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:metadataCallSchema` and `MetadataCall`: a call is `{ kind: "erc20_metadata", block, token }`.
- `src/source.ts:metadataCallsAt(block, tokens)`: one call per token at `block`, tokens lowercased.
- `src/source.ts:fetchMetadata(client, calls)`: makes the calls through `settleCalls` and returns a batch.
- `src/index.ts`: runs `forChain(chainName.parse(process.env.CHAIN))` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=arbitrum pnpm ingest`. A missing or bad `CHAIN` throws before `runSource` starts, so the run logs no fatal line, pushes no metrics and writes no `ops.ingestion_runs` row.
- `chains/<chain>/addresses.json`: `tokens`, a list of EVM addresses.
- `chains/<chain>/.env.example`: `EVM_RPC_URL`, and `RPC_BATCH_SIZE` for `ethereum`. Left empty, `EVM_RPC_URL` becomes a local eRPC URL from the root `ERPC_PORT` (`ingestion/lib/src/env.ts`).
- Settings (`evmEnv` in `ingestion/lib/src/evm/env.ts`): `BLOCK_NUMBER`, `EVM_RPC_URL`, `RPC_BATCH_SIZE`, `RPC_MAX_CONCURRENCY`. The package `.env.example` sets `BLOCK_NUMBER` (`latest`), `RPC_BATCH_SIZE` (10) and `RPC_MAX_CONCURRENCY` (2), with the warehouse settings, `PUSHGATEWAY_URL` and `LOG_LEVEL`.
- `package.json`: `@ingestion/lib`, `viem` and `zod`.

## Invariants

- `connect` turns a `BLOCK_NUMBER` tag into one block number at the start of the run, so every token in the run is read at the same block.
- A call carries its block, so a dead letter retried in a later run reads the block it missed.
- The call id and the record id are both `<block>:<token>` (`src/source.ts:callId`), so a rerun at the same block replaces the record and clears the dead letter of its call.
- Each record's `data` holds `block_number`, `token`, `name`, `symbol` and `decimals`.
- ERC-20 makes all three functions optional. A revert (viem's `RawContractError`) or an empty reply gives `null` for that field, not a failed call. Any other error fails the call.
- `text` decodes a name or symbol as an ABI string. When that fails and the reply is exactly 32 bytes, it decodes it as a bytes32, as some old tokens return. A reply of any other length fails the call. viem's `decodeFunctionResult` ignores extra bytes, so the length check comes first.
- `text` drops every zero byte, since Postgres rejects them in jsonb and one would fail the whole batch. An empty result becomes `null`.
- The three reads of a token start in one tick, so the client sends every read at the same block as one Multicall3 call (`createEvmClient` in `ingestion/lib/src/evm/client.ts`).
- `callBatches` skips a retried call that equals a fresh one, so no call goes out twice in one run.
- `addresses.json` is read inside `extract` with `readJson`, and `validateEthAddressList` rejects a bad address.

## Side Effects

- JSON-RPC `eth_call`s to `EVM_RPC_URL`, three per token, batched through Multicall3, and one block lookup when `BLOCK_NUMBER` is a tag.
- `runSource` writes the records to `raw.<chain>_erc20_metadata`, failed calls to `raw._dead_letters`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-erc20-metadata test`
- Run: `pnpm -C ingestion typecheck`
