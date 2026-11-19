# marts/hypercore

## Overview

HyperCore fills and signed L1 actions, for the users and coins the `hypercore-fills` and `hypercore-actions` sources follow. This folder is the `hypercore` pipeline: its entry in `PIPELINES` in `orchestration/pipeline/schedules.py` (cron `0 6 * * *`) makes a Dagster job that builds these marts and everything upstream of them, ingestion included. Marts build as tables (`marts: +materialized: table` in `transformation/dbt_project.yml`). The fill rules are in [intermediate/hypercore](../../intermediate/hypercore/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `hypercore_fills` | One fill, one user's side of one trade; `id` (`<block>:<fillIndex>`) | `int_hypercore_fills` |
| `hypercore_actions` | One signed L1 action; `id` (`<block>:<actionIndex>`) | `stg_hypercore__actions` |

Columns:

- `hypercore_fills`: `id`, `block_number`, `block_timestamp`, `fill_time`, `fill_index`, `tx_hash`, `tid`, `oid`, `cloid`, `twap_id`, `user_address`, `coin`, `side`, `dir`, `px`, `sz`, `signed_size`, `notional`, `is_taker`, `start_position`, `closed_pnl`, `fee`, `fee_token`, `builder`, `builder_fee`.
- `hypercore_actions`: `id`, `block_number`, `block_timestamp`, `action_index`, `user_address`, `vault_address`, `action_type`, `action`, `status`, `response`, `nonce`.

## Invariants

- `hypercore_fills.sql`: the two sides of a trade are two rows that share `tid`. `px` is in the coin's quote asset per coin; `sz`, `signed_size` and `start_position` are in coin units; `fee` is in `fee_token`; `notional` is in the coin's quote asset, which may not be USD. `signed_size` is positive for a buy and negative for a sell.
- `hypercore_actions.sql`: `action` holds the payload as the user signed it, and its keys depend on `action_type`; orders name assets by number, not by coin. An `ok` status can still carry errors inside `response`, which is a JSON string rather than an object on some rejected actions. `vault_address` is null when the user acted for itself.
- Both marts rebuild whole, not incrementally: the raw tables offer no change feed an incremental build could trust (`docs/fact-model-performance.md`).
- `_hypercore__models.yml`: `unique` and `not_null` on `id` of both marts. On `hypercore_fills`, `accepted_values` `[A, B]` on `side`, and `not_null` on `block_number`, `user_address`, `coin`, `px`, `sz`, `signed_size`, `notional` and `tid`; the test on `signed_size` fails on a side the rules do not know. On `hypercore_actions`, `not_null` on `block_number`, `action_index`, `user_address`, `action_type` and `status`, and `accepted_values` `[ok, err]` on `status`.

## Side Effects

- Builds two tables, `hypercore_fills` and `hypercore_actions`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run hypercore --select hypercore_fills` builds the mart and runs its tests.
