# EVM

## Overview

EVM code for sources, imported as `@ingestion/lib/evm`: address checks, the settings an EVM call source reads, and a viem client that batches calls and reads every call in a run at one block. Part of [`@ingestion/lib`](../../README.md).

## Interface

- `address` (`address.ts`): a zod schema for an Ethereum address, checked with viem's `isAddress`.
- `toLower(address)` (`address.ts`): the address in lowercase.
- `validateEthAddressList(addresses)` (exported name of `address.ts:validateAddressList`): returns the list unchanged as `Address[]`, or throws one error that lists every invalid address.
- `evmEnv` / `EvmEnv` (`env.ts`):
  - `BLOCK_NUMBER`: `latest`, `safe`, `finalized` or a whole number up to `Number.MAX_SAFE_INTEGER` (`env.ts:blockNumber`).
  - `EVM_RPC_URL`: a URL.
  - `RPC_BATCH_SIZE`: most JSON-RPC calls per HTTP request, default 100.
  - `RPC_MAX_CONCURRENCY`: most HTTP requests in flight, default 16.
- `createEvmClient(rpcUrl, { maxConcurrency = 16, retryCount = 5, batchSize = 100 })` / `EvmClient` (`client.ts`): a viem public client.
- `connect(env)` (`client.ts`): `{ client, block }`, the client for `EVM_RPC_URL` built with `RPC_BATCH_SIZE` and `RPC_MAX_CONCURRENCY`, and the number `BLOCK_NUMBER` resolves to.
- `resolveBlock(client, block)` (`client.ts`, not exported from `index.ts`): turns a block tag into a number.

## Invariants

- A mixed-case address must carry a valid EIP-55 checksum. An all-lowercase one passes as is. `validateEthAddressList` does not change case.
- `readContract` calls made in the same tick at the same `blockNumber` go out as one Multicall3 `aggregate3` `eth_call`. Deployless mode sends the Multicall3 bytecode with the call, so it works on any chain and at blocks before Multicall3 was deployed.
- Calls sent in the same tick go out as JSON-RPC batches of up to `batchSize` per HTTP request.
- At most `maxConcurrency` HTTP requests run at once (`../concurrency.ts:createLimiter`). viem retries a request up to `retryCount` times; the client passes the count so a viem upgrade cannot change it.
- `connect` resolves a tag once. Calls carry that number, so every call in the run reads the same block, and a call retried in a later run reads the block it missed.
- When `EVM_RPC_URL` is unset and `CHAIN` is `ethereum`, `arbitrum`, `base` or `polygon`, `loadEnv` fills in a local eRPC URL from `ERPC_PORT` (`../env.ts:localEndpoints`).

## Side Effects

- Every HTTP request goes through `observedFetch`, and a wait for a free slot through `observeQueue`, so the run's transport metrics count both.
- `connect` sends one `getBlock` call when `BLOCK_NUMBER` is a tag, and none when it is a number.
- `address`, `toLower`, `validateEthAddressList` and `evmEnv`: none.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/lib test`
- Run: `pnpm -C ingestion typecheck`
