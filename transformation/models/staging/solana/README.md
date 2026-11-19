# Solana staging

## Overview

Typed views over the two raw tables of Solana wallet balances: native SOL and SPL tokens. Each casts its fields out of `data`. There are no joins and no rules here: those live in `models/intermediate/balances/`.

## Interface

`_solana__sources.yml` declares the dbt source `solana` in schema `RAW_SCHEMA` (default `raw`), with the tables `sol_balances` and `spl_balances` (identifiers `solana_sol_balances`, `solana_spl_balances`).

| Model | Reads | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- |
| `stg_solana__sol_balances` | `raw.solana_sol_balances` | `solana-sol-balances` | wallet and run, at the latest finalized slot the run read | `int_solana_balances` | balances |
| `stg_solana__spl_balances` | `raw.solana_spl_balances` | `solana-spl-balances` | wallet, mint and run: the sum of the wallet's token accounts for that mint | `int_solana_balances` | balances |

Columns:

- `stg_solana__sol_balances`: `id`, `slot`, `wallet`, `balance` (lamports), `_loaded_at`.
- `stg_solana__spl_balances`: `id`, `slot`, `wallet`, `mint`, `balance` (token base units), `_loaded_at`.

## Invariants

- `id` is `unique` and `not_null` on each raw table (`_solana__sources.yml`) and on each view (`_solana__models.yml`).
- `slot`, `wallet` and `balance` are `not_null` on both views, and `mint` on `stg_solana__spl_balances`.
- `wallet` and `mint` keep the case the source wrote, with no `lower()`: base58 is case-sensitive (`transformation/CLAUDE.md`).
- The views carry a `slot`, not a `block_number`.
- The source name and table name match the ingestion source's `name` and `table` (comment in `_solana__sources.yml`), which is how Dagster links the ingestion assets `[solana, <table>]` to the dbt sources.

## Side Effects

- A dbt build creates or replaces each view in `DBT_SCHEMA` (`analytics`), since `dbt_project.yml` sets `staging: +materialized: view`. The views read the raw tables live and copy no rows.
- Nothing here writes to `RAW_SCHEMA`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run balances --select stg_solana__sol_balances` builds a view and runs its tests.
