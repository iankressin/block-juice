# intermediate/prices

## Overview

Chainlink rounds on Ethereum, Arbitrum and Base, in the shape `oracle_prices` reads, and Binance and Coinbase candles, in the shape `token_prices` reads ([marts/prices](../../marts/prices/README.md)). There is one model per chain or exchange. `transformation/dbt_project.yml` builds them as views (`prices: +materialized: view`).

## Interface

| Model | Grain and key | Reads | Read by |
|---|---|---|---|
| `int_ethereum_chainlink_prices` | One round of a seeded feed; `id` | `stg_ethereum__chainlink_price_feeds`, seed `chainlink_feeds` | `oracle_prices` |
| `int_arbitrum_chainlink_prices` | One round of a seeded feed; `id` | `stg_arbitrum__chainlink_price_feeds`, seed `chainlink_feeds` | `oracle_prices` |
| `int_base_chainlink_prices` | One round of a seeded feed; `id` | `stg_base__chainlink_price_feeds`, seed `chainlink_feeds` | `oracle_prices` |
| `int_binance_token_prices` | One candle; `id` | `stg_binance__candles` | `token_prices` |
| `int_coinbase_token_prices` | One candle; `id` | `stg_coinbase__candles` | `token_prices` |

Columns:

- Chainlink models: `chain`, `oracle` (`'chainlink'`), `id`, `feed`, `token`, `quote`, `proxy`, `aggregator`, `round_id`, `price`, `answer`, `decimals`, `updated_at`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`.
- Candle models: `exchange` (`'binance'` or `'coinbase'`), `id`, `token`, `quote`, `interval`, `open_time`, `close_time`, `open`, `high`, `low`, `close`, `volume`, `quote_volume`, `trades`.

## Invariants

- A round joins the `chainlink_feeds` seed on its chain and `aggregator`. A round from an aggregator with no seed row drops out.
- `token` and `quote` split the feed's name on `' / '`, so an `ETH / USD` feed gives token `ETH` and quote `USD`.
- `round_id` is the id the proxy reports: `phase_id * 2^64 + aggregator_round_id`.
- `price` is `answer * 10^-decimals`, then `trim_scale`. It multiplies rather than divides, since Postgres rounds a quotient to about 16 significant digits and would cut short an 18-decimal feed's price.
- `int_coinbase_token_prices.sql` sets `quote_volume` and `trades` to null: Coinbase sends neither.
- `_int_prices__models.yml`: `unique` and `not_null` on `id` of all five models. Unit test `a_chainlink_round_is_priced_by_its_feed`, built on proof row 1 of `catalog/protocols/chainlink/NOTES.md`.

## Side Effects

- Builds five views in the `analytics` schema (`DBT_SCHEMA`), one per model above.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run prices --select int_ethereum_chainlink_prices` builds the model and runs its tests.
