# solana-sol-balances

## Overview

A call source that reads the SOL balance of each wallet listed in `addresses.json` at the latest finalized slot. It loads into `raw.solana_sol_balances`, which dbt reads through `transformation/models/staging/solana/stg_solana__sol_balances.sql`. Solana RPCs serve only current state, so a run cannot read a past slot.

## Interface

- `src/source.ts:solanaSolBalances`: the `Source<SolanaEnv, BalanceCall>` with `name` `solana` and `table` `sol_balances`.
- `src/balances.ts:balanceCallSchema` and `BalanceCall`: a call is `{ kind: "sol_balance", wallet }`.
- `src/balances.ts:balanceCalls(wallets)`: one call per wallet.
- `src/balances.ts:fetchBalances(rpc, calls)`: one `getMultipleAccounts` per 100 wallets (`ACCOUNTS_PER_CALL`), returning a batch.
- `src/index.ts`: runs `solanaSolBalances` through `runSource`.
- `addresses.json`: `wallets`, a list of Solana addresses, checked by `validateSolanaAddressList`.
- Settings (`solanaEnv` in `ingestion/lib/src/solana/env.ts`): `SOLANA_RPC_URL`.

## Invariants

- The call id is the wallet alone, since a retried call reads the balance as it is now. The record id is `<slot>:<wallet>`, so each run keeps its own reading.
- Each group of up to 100 wallets is read in one call at `finalized` commitment, so every wallet in the group shares one slot. A failed group fails each of its wallets' calls.
- Each record's `data` holds `slot`, `wallet` and `balance` in lamports. An address with no account reads as `0`.
- Duplicate wallets in one batch collapse to one call (`uniqueBy`). `callBatches` skips a retried wallet that is still listed, since the fresh call reads it.
- `addresses.json` is read inside `extract` with `readJson`, so a bad file fails the run with a logged reason.

## Side Effects

- JSON-RPC `getMultipleAccounts` calls to `SOLANA_RPC_URL`, with a zero-length `dataSlice`. `createSolanaClient` sends at most 16 at once and retries a call that got no reply 5 times with backoff.
- `runSource` writes the records to `raw.solana_sol_balances` (`id`, `data`, `_loaded_at`), keeps failed calls in `raw._dead_letters`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/solana-sol-balances test`
- Run: `pnpm -C ingestion typecheck`
