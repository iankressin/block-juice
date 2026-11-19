# marts/prices

## Overview

Chainlink oracle rounds on Ethereum, Arbitrum and Base, and exchange candles from Binance and Coinbase. This folder is the `prices` pipeline: its entry in `PIPELINES` in `orchestration/pipeline/schedules.py` (cron `0 6 * * *`) makes a Dagster job that builds these marts and everything upstream of them, ingestion included. The per-chain and per-exchange models are in [intermediate/prices](../../intermediate/prices/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `oracle_prices` | One round of one feed; `(chain, id)`, also `(chain, proxy, round_id)` | `int_ethereum_chainlink_prices`, `int_arbitrum_chainlink_prices`, `int_base_chainlink_prices` |
| `token_prices` | One candle; `(exchange, token, quote, interval, open_time)` | `int_binance_token_prices`, `int_coinbase_token_prices` |

Columns:

- `oracle_prices`: `chain`, `oracle`, `id` (`<block>:<logIndex>`), `feed`, `token`, `quote`, `proxy`, `aggregator`, `round_id`, `price`, `answer`, `decimals`, `updated_at`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`.
- `token_prices`: `exchange`, `token`, `quote`, `interval`, `open_time`, `close_time`, `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `trades`.

## Invariants

- `oracle_prices.sql`: `price` is the answer scaled by the feed's decimals, in quote units, so an `ETH / USD` row gives ETH's price in USD. `round_id` is `phaseId << 64 | the aggregator's round id`, as the proxy reports it.
- `token_prices.sql`: prices are in quote-asset units, `volume` in token units, `quote_volume` in quote-asset units. Coinbase sends no `quote_volume` or `trades`, so both are null on its rows.
- Both marts call `fact_config` (`macros/reconcile.sql`): `oracle_prices` with `(chain, id)` alone, `token_prices` with its grain. By default (`var('fact_strategy', 'table')`) it builds a table and runs `analyze` after. With `fact_strategy: reconcile` it builds incrementally on those keys, still reading its whole input. A `fact_strategy` other than `table` or `reconcile`, or a `fact_indexes` that is not a YAML boolean, fails compilation.
- `_prices__models.yml`: on `oracle_prices`, `unique` on `chain || ':' || id` and on `chain || ':' || proxy || ':' || round_id`; `accepted_values` on `chain` (`ethereum`, `arbitrum`, `base`) and `oracle` (`chainlink`); `not_null` on `chain`, `oracle`, `id`, `proxy`, `round_id`, `price` and `updated_at`. On `token_prices`, `accepted_values` on `exchange` (`binance`, `coinbase`) and `interval`; `not_null` on every column but `quote_volume` and `trades`.
- Singular tests: `tests/token_prices_one_row_per_candle.sql` checks the `token_prices` grain. `tests/oracle_prices_within_heartbeat.sql` (severity `warn`) lists each `chainlink_feeds` feed with no round in the two heartbeats before its chain's cursor time (`current_timestamp` in `_sync`, read from the `RAW_SCHEMA` schema, default `raw`). A chain whose source has no `_sync` row drops out of the inner join, so its feeds never warn.

## Side Effects

- Builds two tables, `oracle_prices` and `token_prices`, in the `analytics` schema (`DBT_SCHEMA`), then runs `analyze` on each.
- With `fact_strategy: reconcile`, takes a transaction-level advisory lock on each table (`reconcile_lock`) before it writes, deletes the rows whose key left the new result, merges the rest and keeps the columns in step with the model (`on_schema_change='sync_all_columns'`). After the write, `reconcile_key` adds a unique index on the key and sets its columns `not null`. See [macros](../../../macros/README.md).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run prices --select oracle_prices` builds the mart and runs its tests.
