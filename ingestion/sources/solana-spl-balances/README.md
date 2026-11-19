# solana-spl-balances

## Overview

A call source that reads, for each wallet and each mint listed in `addresses.json`, the wallet's balance of that token at the latest finalized slot. It covers both the Token and Token-2022 programs. It loads into `raw.solana_spl_balances`, which dbt reads through `transformation/models/staging/solana/stg_solana__spl_balances.sql`. Solana RPCs serve only current state, so a run cannot read a past slot.

## Interface

- `src/source.ts:solanaSplBalances`: the `Source<SolanaEnv, BalanceCall>` with `name` `solana` and `table` `spl_balances`.
- `src/balances.ts:balanceCallSchema` and `BalanceCall`: a call is `{ kind: "spl_balance", mint, wallet }`.
- `src/balances.ts:balanceCalls(wallets, mints)`: one call per mint and wallet.
- `src/balances.ts:fetchBalances(rpc, calls)`: one `getTokenAccountsByOwner` per call, through `settleCalls`.
- `src/index.ts`: runs `solanaSplBalances` through `runSource`.
- `addresses.json`: `wallets` and `mints`, lists of Solana addresses, each checked by `validateSolanaAddressList`.
- Settings (`solanaEnv` in `ingestion/lib/src/solana/env.ts`): `SOLANA_RPC_URL`.

## Invariants

- The call id is `<mint>:<wallet>`, with no slot, since a retried call reads the balance as it is now. The record id is `<slot>:<mint>:<wallet>`, so each run keeps its own reading.
- A wallet can hold one mint in several token accounts, so `balanceOf` sums their raw `tokenAmount.amount`. Each record's `data` holds `slot`, `mint`, `wallet` and `balance` in the mint's base units. Decimals are dbt's.
- Calls read at `finalized` commitment with `jsonParsed` encoding.
- The client sends at most 2 calls at once (`maxConcurrency: 2`), since the free RPCs that serve `getTokenAccountsByOwner` allow about 2 a second.
- `callBatches` skips a retried call whose wallet and mint are both still listed, since the fresh call reads it.
- `addresses.json` is read inside `extract` with `readJson`, so a bad file fails the run with a logged reason.

## Side Effects

- JSON-RPC `getTokenAccountsByOwner` calls to `SOLANA_RPC_URL`. `createSolanaClient` retries a call that got no reply 5 times with backoff.
- `runSource` writes the records to `raw.solana_spl_balances` (`id`, `data`, `_loaded_at`), keeps failed calls in `raw._dead_letters`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/solana-spl-balances test`
- Run: `pnpm -C ingestion typecheck`
