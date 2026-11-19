# HyperCore staging

## Overview

Typed views over the two raw tables that the HyperCore sources load: fills and signed actions. Each casts its fields out of `data -> 'fill'` or `data -> 'action'` and lowercases addresses. There are no joins and no rules here. Field meanings are in `catalog/protocols/hypercore/NOTES.md`.

## Interface

`_hypercore__sources.yml` declares the dbt source `hypercore` in schema `RAW_SCHEMA` (default `raw`), with the tables `fills` and `actions` (identifiers `hypercore_fills`, `hypercore_actions`).

| Model | Reads | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- |
| `stg_hypercore__fills` | `raw.hypercore_fills` | `hypercore-fills` | one user's side of one trade, for the users and coins in its `addresses.json` | `int_hypercore_fills` | hypercore |
| `stg_hypercore__actions` | `raw.hypercore_actions` | `hypercore-actions` | one signed action (an order, a cancel, a leverage change and so on) sent by a user in its `addresses.json` | the mart `hypercore_actions` | hypercore |

Columns. Both views also have `id`, `block_number`, `block_timestamp` and `_loaded_at`.

- `stg_hypercore__fills`: `fill_index`, `user_address`, `coin`, `px`, `sz`, `side` (`B` bid or buy, `A` ask or sell), `fill_time`, `start_position`, `dir`, `closed_pnl`, `tx_hash`, `oid`, `crossed`, `fee` (in `fee_token`; negative is a rebate to the user), `builder_fee`, `tid`, `cloid`, `fee_token`, `builder`, `twap_id`.
- `stg_hypercore__actions`: `action_index`, `user_address`, `vault_address` (null when the user acted for itself), `action_type`, `action` (jsonb, the payload as signed; its keys depend on `action_type`), `status` (`ok` or `err`), `response` (jsonb: an object for most actions, a string for some rejected ones), `nonce`.

## Invariants

- `id` is `unique` and `not_null` on each raw table (`_hypercore__sources.yml`) and on each view (`_hypercore__models.yml`).
- `stg_hypercore__fills`: `block_number`, `user_address`, `coin`, `px`, `sz` and `tid` are `not_null`. The two sides of one trade share `tid`.
- `stg_hypercore__fills`: `px`, `sz` and `fee` are decimals as HyperCore sends them, not base units. `fill_time` comes from epoch milliseconds.
- `stg_hypercore__actions`: `block_number`, `action_index`, `user_address`, `action_type` and `status` are `not_null`.
- `user_address`, `vault_address` and `builder` go through `lower()`.
- The source name and table name match the ingestion source's `name` and `table` (comment in `_hypercore__sources.yml`), which is how Dagster links the ingestion assets `[hypercore, <table>]` to the dbt sources.

## Side Effects

- A dbt build creates or replaces each view in `DBT_SCHEMA` (`analytics`), since `dbt_project.yml` sets `staging: +materialized: view`. The views read the raw tables live and copy no rows.
- Nothing here writes to `RAW_SCHEMA`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run hypercore --select stg_hypercore__fills` builds a view and runs its tests.
