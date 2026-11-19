# marts/polymarket

## Overview

Polymarket markets, trades, wallet fills, signed orders, 1-minute price candles and each wallet's PnL per market. This folder is the `polymarket` pipeline: its entry in `PIPELINES` in `orchestration/pipeline/schedules.py` (cron `0 6 * * *`) makes a Dagster job that builds these marts and everything upstream of them, ingestion included. The rules live in [intermediate/polymarket](../../intermediate/polymarket/README.md).

`transformation/dbt_project.yml` builds the marts as tables (`marts: +materialized: table`) with the pre-hook `set local enable_nestloop = off`, as for the intermediate models.

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `polymarket_markets` | One condition of a Gamma v1 market; `condition_id` | `stg_polymarket__markets`, `int_polygon_polymarket_ctf_conditions`, `int_polygon_polymarket_ctf_resolutions`; `depends_on` `int_polymarket_markets`, `int_polymarket_outcome_tokens` |
| `polymarket_trades` | One maker-order fill, the tick chart; `id` | `int_polygon_polymarket_ctf_exchange_v2_fills`, `int_polymarket_outcome_tokens` |
| `polymarket_wallet_fills` | One fill per wallet, maker and taker order alike; `id` | `int_polygon_polymarket_ctf_exchange_v2_fills`, `int_polymarket_outcome_tokens` |
| `polymarket_wallet_orders` | One order that loaded fills name and whose signed order loaded; `order_hash` | `int_polygon_polymarket_ctf_exchange_v2_orders` |
| `polymarket_price_candles` | One outcome token and minute; `(token_id, minute)` | `polymarket_trades`, `int_polymarket_outcome_tokens` |
| `polymarket_market_participants` | One market and wallet; `(condition_id, wallet)` | `int_polymarket_wallet_ledger`, `polymarket_markets`, `int_polymarket_outcome_tokens`, `polymarket_price_candles` |

Key columns (the full lists are in `_polymarket__models.yml`):

- `polymarket_markets`: Gamma's names (`market_id`, `question`, `slug`, `event_id`, `event_title`, `outcomes`, `end_date`, `is_sports`, `sports_market_type`, `series_slug`, `game_start_time`), `neg_risk`, `protocol` (`ctf`), `prepared_block`, `resolved_at`, `payout_fractions`, `history_complete`.
- `polymarket_trades`: `condition_id`, `token_id`, `outcome`, `maker`, `taker`, `maker_side`, `shares`, `usdc`, `price`, `fee_usdc`.
- `polymarket_wallet_fills`: `order_hash`, `wallet`, `role` (`maker` or `taker`), `counterparty`, `condition_id`, `token_id`, `outcome_index`, `outcome`, `complement_token_id`, `side`, `shares`, `usdc`, `fee_usdc`, `price`.
- `polymarket_wallet_orders`: `wallet`, `signer`, `signature_type`, `exchange`, `condition_id`, `token_id`, `side`, `posted_shares`, `posted_usdc`, `limit_price`, `signed_at`, `first_fill_at`, `last_fill_at`, `fills`, `taker_fills`, `filled_shares`, `filled_usdc`, `fee_usdc`, `filled_in_full`, `salt`, `metadata`, `builder`.
- `polymarket_price_candles`: `condition_id`, `outcome`, `open`, `high`, `low`, `close`, `trades`, `shares_volume`, `usdc_volume`.
- `polymarket_market_participants`: `trades`, `buy_usdc`, `sell_usdc`, `fees_usdc`, `net_cash_usdc`, `open_shares`, `position_value_usdc`, `pnl_usdc`, `first_activity_at`, `last_activity_at`, `resolved`, `history_complete`.

## Invariants

- Units: shares are outcome tokens and cash is pUSD; prices are pUSD per share. `usdc` is before fees. Amounts from base units are divided by 1e6 and kept at 6 places.
- `polymarket_markets.sql`: rows are the conditions `int_polymarket_outcome_tokens` would give tokens for, picked the same way (the lowest numeric market id wins). `payout_fractions` are in `outcome_index` order and null until resolved. A condition prepared before the window has a null `prepared_block` and `history_complete` false.
- `polymarket_trades.sql` keeps maker fills only: the taker order's own fill repeats its makers' volume, so it stays out. `polymarket_wallet_fills.sql` keeps both, with `role` taker on the taker order's own fill, so a wallet's taker fills count. Trades drop a fill of a token Gamma lacks (inner join); wallet fills keep it, with the Gamma columns null.
- `polymarket_wallet_orders.sql`: an order filled in full when its fills' maker amounts add up to its posted `makerAmount`. One not filled in full was cancelled off chain, at a time the chain does not record, or is still open. Orders that never filled are not on chain. A fill that matched no signed order is left out.
- `polymarket_price_candles.sql`: in a two-outcome market, a trade of one token at `price` also prices the other at `1 - price`. Open and close follow `(block_number, log_index)` order. `trades` and the volumes count only the token's own trades, so a minute in which only the other token traded has prices and zero volume.
- `polymarket_market_participants.sql`: `net_cash_usdc` sums the ledger's `usdc_delta`, after fees. Shares held count only the moves after the wallet's last move that zeroed the position. A token's mark is its payout fraction once resolved, else its last candle's close. `position_value_usdc`, and so `pnl_usdc = net_cash_usdc + position_value_usdc`, is null when a held token has no mark. When `history_complete` is false, PnL misses what happened before the window.
- Tests in `_polymarket__models.yml`: `unique` and `not_null` on `condition_id` of markets, on `id` of trades and wallet fills, and on `order_hash` of wallet orders; `not_null` on each grain column and the main amounts; `accepted_values` on `version`, `maker_side`, `role` and `side`. Seven unit tests, such as `trades_keep_maker_fills_only` and `pnl_of_a_resolved_market`.
- Singular tests: `tests/polymarket_price_candles_one_row_per_minute.sql`, `tests/polymarket_market_participants_one_row_per_wallet.sql` (the grain of those two marts), `tests/polymarket_payouts_sum_to_one.sql`, `tests/polymarket_prices_within_unit_interval.sql` and `tests/polymarket_resolved_markets_are_zero_sum.sql`.

## Side Effects

- Builds six tables in the `analytics` schema (`DBT_SCHEMA`), one per mart above.
- Runs `set local enable_nestloop = off` before each build, which lasts only for that model's transaction.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run polymarket --select polymarket_market_participants` builds the mart and runs its tests.
