# Solana

## Overview

Solana code for sources, imported as `@ingestion/lib/solana`: address checks, the settings a Solana source reads, and an RPC client from `@solana/kit` with a bound on concurrent requests and retries only for requests that got no reply. Part of [`@ingestion/lib`](../../README.md).

## Interface

- `solanaAddress` (`address.ts`): a zod schema for a Solana address, checked with `@solana/kit`'s `isAddress`.
- `validateSolanaAddressList(addresses)` (`address.ts`): returns the list unchanged as `Address[]`, or throws one error that lists every invalid address.
- `solanaEnv` / `SolanaEnv` (`env.ts`): `SOLANA_RPC_URL`, a URL.
- `createSolanaClient(url, { maxConcurrency = 16, retryCount = 5 })` / `SolanaClient` (`client.ts`): the RPC from `createSolanaRpcFromTransport`, over a transport built on `createDefaultRpcTransport`.
- `index.ts` exports all of the above.

## Invariants

- Solana addresses are case-sensitive base58, so the helpers keep them exactly as written.
- At most `maxConcurrency` requests run at once (`../concurrency.ts:createLimiter`).
- `withRetry` retries a request that got no reply, such as while eRPC restarts, up to `retryCount` times, waiting 150 ms × 2^attempt between tries.
- An HTTP error (`SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR`) is never retried: eRPC sends one only after its own retries across every upstream. Any reply, an HTTP error or a JSON-RPC error inside it, goes to the caller.
- A JSON-RPC error whose code `@solana/kit` has no name for, such as `-32000`, is thrown as a plain `Error("JSON-RPC error <code>: <message>")` (`throwUnnamedRpcError`). `@solana/errors` 8.6 would throw a `TypeError` and lose the reply.
- Solana RPCs serve only current state: reads take a commitment, not a slot, and each reply's `context.slot` says which slot it was read at.

## Side Effects

- `createSolanaClient` sends HTTP JSON-RPC requests to `url`. `observeRequest` counts each attempt and `observeDelay` each backoff in the run's transport metrics; `observeQueue` counts waits for a slot.
- `solanaAddress`, `validateSolanaAddressList` and `solanaEnv`: none.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/lib test`
- Run: `pnpm -C ingestion typecheck`
