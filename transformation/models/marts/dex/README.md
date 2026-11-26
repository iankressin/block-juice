# marts/dex

## Overview

One DEX trade per row, a Swap log in which the swapper received one token and paid another, for every pool a source loads. This folder is the `dex` pipeline: `orchestration/pipeline/schedules.py` makes a Dagster job of it (cron `0 6 * * *`) that builds this mart and everything upstream of it, ingestion included. The per-version models and their rules are in [intermediate/dex](../../intermediate/dex/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `dex_trades` | One Swap that traded; `(chain, id)` | `int_ethereum_uniswap_v2_trades`, `int_ethereum_uniswap_v3_trades`, `int_ethereum_uniswap_v4_trades` |

Columns: `id`, `chain`, `protocol`, `version`, `pool`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `tx_from`, `sender`, `recipient`, `hooks`, `token_bought`, `amount_bought`, `token_sold`, `amount_sold`.

## Invariants

- `dex_trades.sql` unions one intermediate model per protocol version, with `version` naming each row's version. A new version adds one branch.
- Amounts are in each token's base units, with no decimals or prices. A token of `0x0000000000000000000000000000000000000000` is native ETH.
- `tx_from` signed the transaction. `sender` and `recipient` are the pool's own fields, often a router; v4 has no recipient. `pool` is the pool's address, or its id in v4.
- One trade can show up in two versions' rows in the same transaction, such as a v4 hook that fills a swap from a v2 pair.
- `fact_config(['chain', 'id'], indexes=[{'columns': ['chain', 'version', 'block_number']}])` (`macros/reconcile.sql`) sets the materialization. By default (`var('fact_strategy', 'table')`) it builds a table and runs `analyze` after. With `fact_strategy: reconcile` it builds incrementally on the key `(chain, id)`, still reading its whole input. The index builds only when `fact_indexes` is true. A `fact_strategy` other than `table` or `reconcile`, or a `fact_indexes` that is not a YAML boolean, fails compilation.
- `_dex__models.yml`: `unique` and `not_null` on `id`; `accepted_values` on `chain` (`ethereum`), `protocol` (`uniswap`) and `version` (`v2`, `v3`, `v4`); `not_null` on `pool`, `block_number`, `tx_hash`, `tx_from`, `token_bought`, `amount_bought`, `token_sold` and `amount_sold`.

## Side Effects

- Builds the table `dex_trades` in the `analytics` schema (`DBT_SCHEMA`), then runs `analyze` on it.
- With `fact_strategy: reconcile`, takes a transaction-level advisory lock on the table (`reconcile_lock`) before it writes, deletes the rows whose key left the new result, merges the rest and keeps the columns in step with the model (`on_schema_change='sync_all_columns'`). After the write, `reconcile_key` adds a unique index on the key and sets its columns `not null`. See [macros](../../../macros/README.md).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run dex --select dex_trades` builds the mart and runs its tests.
