# intermediate/accounts

## Overview

Ethereum wallet transactions and account state reads, brought into the shape the `accounts` pipeline's marts read ([marts/accounts](../../marts/accounts/README.md)). `transformation/dbt_project.yml` sets no materialization for this folder, so the models stay ephemeral: dbt inlines them into the marts that ref them, and they show as no step of their own in Dagster.

## Interface

| Model | Grain and key | Reads | Read by |
|---|---|---|---|
| `int_ethereum_wallet_transactions` | One top-level transaction; `tx_hash` | `stg_ethereum__wallet_transactions` | `wallet_transactions` |
| `int_ethereum_account_states` | One address and block; `address`, `block_number` | `stg_ethereum__account_state` | `account_states` |

Columns:

- `int_ethereum_wallet_transactions`: `chain` (`'ethereum'`), `block_number`, `block_timestamp`, `transaction_index`, `tx_hash`, `from_address`, `to_address`, `value_wei`, `succeeded`, `tx_type`, `gas_used`, `effective_gas_price`, `fee_wei`, `blob_fee_wei`.
- `int_ethereum_account_states`: `chain` (`'ethereum'`), `address`, `block_number`, `balance_wei`, `nonce`, `code`, `code_kind`.

## Invariants

- `int_ethereum_wallet_transactions.sql`: `succeeded` is `status = 1`. `fee_wei` is `gas_used * effective_gas_price`, in wei, paid whether the transaction succeeded or reverted. `blob_fee_wei` is `blob_gas_used * blob_gas_price`, and 0 when those are null, as on every transaction but type 3. Unit test `the_fee_is_gas_used_times_effective_gas_price_even_on_a_revert`.
- `int_ethereum_account_states.sql`: keeps one read per `(block_number, kind, address)`, the one with the latest `_loaded_at`, then pivots the `balance`, `nonce` and `code` reads into columns. A read that has not loaded yet, such as one waiting in the dead letters, leaves its column null.
- `code_kind` is null when no code read loaded, `none` for code `0x`, `eip7702_delegation` for code matching `^0xef0100[0-9a-f]{40}$` (EIP-7702), and `contract` for any other code. Unit test `code_kind_tells_delegations_from_contracts`.
- `_int_accounts__models.yml`: `unique` and `not_null` on `int_ethereum_wallet_transactions.tx_hash`; `unique` on `address || ':' || block_number` of `int_ethereum_account_states`.

## Side Effects

- None. Ephemeral models create no relation in the warehouse.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up, build a mart that inlines these models and run its tests: `uv run --project orchestration bj run accounts --select wallet_transactions` (or `--select account_states`).
