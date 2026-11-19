# Bitcoin staging

## Overview

One typed view over the raw table of Bitcoin wallet balances. It casts the fields out of `data`. There are no joins and no rules here: those live in `models/intermediate/balances/`.

## Interface

`_bitcoin__sources.yml` declares the dbt source `bitcoin` in schema `RAW_SCHEMA` (default `raw`), with the table `btc_balances` (identifier `bitcoin_btc_balances`).

| Model | Reads | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- |
| `stg_bitcoin__btc_balances` | `raw.bitcoin_btc_balances` | `bitcoin-btc-balances` | wallet and run, at the chain tip the run's scan read | `int_bitcoin_balances` | balances |

Columns: `id`, `block_number`, `wallet`, `balance` (satoshis), `_loaded_at`.

## Invariants

- `id` is `unique` and `not_null` on the raw table (`_bitcoin__sources.yml`) and on the view (`_bitcoin__models.yml`).
- `block_number`, `wallet` and `balance` are `not_null` (`_bitcoin__models.yml`).
- `wallet` keeps the case the source wrote, with no `lower()`: Bitcoin addresses can be case-sensitive (`transformation/CLAUDE.md`).
- The source name and table name match the ingestion source's `name` and `table` (comment in `_bitcoin__sources.yml`), which is how Dagster links the ingestion asset `[bitcoin, btc_balances]` to the dbt source.

## Side Effects

- A dbt build creates or replaces the view in `DBT_SCHEMA` (`analytics`), since `dbt_project.yml` sets `staging: +materialized: view`. It reads the raw table live and copies no rows.
- Nothing here writes to `RAW_SCHEMA`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run balances --select stg_bitcoin__btc_balances` builds the view and runs its tests.
