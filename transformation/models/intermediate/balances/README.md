# intermediate/balances

## Overview

Each chain's balance readings, in the one shape `latest_balances` reads ([marts/balances](../../marts/balances/README.md)). There is one model and one YAML file per chain. `transformation/dbt_project.yml` builds them as views (`intermediate: +materialized: view`), so each chain shows as its own step in Dagster.

## Interface

| Model | Grain and key | Reads | `asset_type` | `asset` |
|---|---|---|---|---|
| `int_ethereum_balances` | One balance reading; `id` | `stg_ethereum__eth_balances`, `stg_ethereum__erc20_balances` | `native`, `erc20` | `'eth'` or the token address |
| `int_solana_balances` | One balance reading; `id` | `stg_solana__sol_balances`, `stg_solana__spl_balances` | `native`, `spl` | `'sol'` or the mint address |
| `int_bitcoin_balances` | One balance reading; `id` | `stg_bitcoin__btc_balances` | `native` | `'btc'` |

All three share these columns, with types the contract enforces (`_int_ethereum__models.yml`, `_int_solana__models.yml`, `_int_bitcoin__models.yml`): `id` text, `chain` text, `wallet` text, `asset_type` text, `asset` text, `block_number` bigint, `balance` numeric, `_loaded_at` timestamp with time zone.

## Invariants

- Each model sets `contract: enforced: true`: a change to a column's name or type must change the YAML too, or the build fails.
- `balance` is in the asset's base units: wei, lamports, satoshis or token base units.
- `int_solana_balances.sql` puts the slot in `block_number`.
- `int_ethereum_balances.sql` leaves out ERC-20 readings with a null `balance`, which are reverted calls.
- `id` is the record's key from the raw table, so a rerun replaces a reading instead of adding another.
- Tests in each YAML: `unique` and `not_null` on `id`; `not_null` on `asset` and `balance`; `accepted_values` on `asset_type` with the values in the table above.

## Side Effects

- Builds three views, `int_ethereum_balances`, `int_solana_balances` and `int_bitcoin_balances`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run balances --select int_ethereum_balances` builds the model and runs its tests.
