# Binance staging

## Overview

One typed view over the raw table of Binance candles. It casts the fields out of `data` and turns epoch milliseconds into timestamps. There are no joins and no rules here: those live in `models/intermediate/prices/`.

## Interface

`_binance__sources.yml` declares the dbt source `binance` in schema `RAW_SCHEMA` (default `raw`), with the table `candles` (identifier `binance_candles`).

| Model | Reads | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- |
| `stg_binance__candles` | `raw.binance_candles` | `binance-candles` | Binance candle | `int_binance_token_prices` | prices |

Columns: `id`, `symbol`, `base_asset`, `quote_asset`, `interval`, `open_time`, `close_time`, `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `trades`, `taker_buy_base_volume`, `taker_buy_quote_volume`, `_loaded_at`.

## Invariants

- `id` is `unique` and `not_null` on the raw table (`_binance__sources.yml`) and on the view (`_binance__models.yml`).
- `symbol`, `interval`, `open_time` and `close` are `not_null` (`_binance__models.yml`).
- Prices are in quote-asset units and volume in base-asset units (header of `stg_binance__candles.sql`).
- `open_time` and `close_time` come from epoch milliseconds through `to_timestamp(... / 1000.0)`. `close_time` is the candle's last millisecond.
- The source name and table name match the ingestion source's `name` and `table` (comment in `_binance__sources.yml`), which is how Dagster links the ingestion asset `[binance, candles]` to the dbt source.

## Side Effects

- A dbt build creates or replaces the view in `DBT_SCHEMA` (`analytics`), since `dbt_project.yml` sets `staging: +materialized: view`. It reads the raw table live and copies no rows.
- Nothing here writes to `RAW_SCHEMA`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run prices --select stg_binance__candles` builds the view and runs its tests.
