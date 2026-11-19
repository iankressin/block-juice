# intermediate/polymarket

## Overview

Polymarket's rules on Polygon: CTF Exchange v2 fills and the signed orders behind them, ConditionalTokens splits, merges, redemptions and conversions, condition preparations and resolutions, and Gamma's market and token names. `int_polymarket_wallet_ledger` brings every way a wallet's cash or shares change into one table. The marts in [marts/polymarket](../../marts/polymarket/README.md) read these models.

`transformation/dbt_project.yml` builds the folder as views (`polymarket: +materialized: view`) with the pre-hook `set local enable_nestloop = off`, since filters on jsonb staging columns lead the planner to nested loops that go quadratic. Four models override the view with `config(materialized='table')`: `int_polygon_polymarket_ctf_conditions`, `int_polygon_polymarket_ctf_position_changes` and `int_polymarket_wallet_ledger`, so parallel view swaps of their staging inputs can't deadlock on them, and `int_polygon_polymarket_ctf_exchange_v2_orders`.

## Interface

| Model | Grain and key | Reads |
|---|---|---|
| `int_polygon_polymarket_ctf_exchange_v2_fills` | One `OrderFilled` log, read for its maker; `id` | `stg_polygon__polymarket_ctf_exchange_v2` |
| `int_polygon_polymarket_ctf_exchange_v2_orders` (table) | One fill whose transaction loaded as a `matchOrders` call; `id` | `stg_polygon__polymarket_ctf_exchange_v2`, `stg_polygon__polymarket_ctf_exchange_v2_txs` |
| `int_polygon_polymarket_ctf_position_changes` (table) | One cash or token change from a split, merge, redemption or conversion; `id` | `stg_polygon__polymarket_ctf`, `stg_polymarket__markets`, `int_polymarket_outcome_tokens`, seed `polymarket_contracts` |
| `int_polygon_polymarket_ctf_conditions` (table) | One condition prepared in the window; `condition_id` | `stg_polygon__polymarket_ctf`, `stg_polygon__polymarket_ctf_exchange_v2` |
| `int_polygon_polymarket_ctf_resolutions` | One outcome of a resolved condition; `condition_id`, `outcome_index` | `stg_polygon__polymarket_ctf` |
| `int_polymarket_markets` | One condition of a Gamma v1 market; `condition_id` | `stg_polymarket__markets` |
| `int_polymarket_outcome_tokens` | One outcome token of a Gamma v1 market; `token_id` | `stg_polymarket__markets` |
| `int_polymarket_wallet_ledger` (table) | One change to a wallet's cash or shares in one market; `id` | `int_polygon_polymarket_ctf_exchange_v2_fills`, `int_polygon_polymarket_ctf_position_changes`, `int_polymarket_outcome_tokens` |

Key columns (the full lists are in `_int_polymarket__models.yml`):

- Fills: `version` (`ctf_exchange_v2`), `exchange`, `order_hash`, `wallet` (the maker), `counterparty`, `is_taker_order`, `token_id`, `side`, `shares`, `usdc`, `fee_usdc`, `price`.
- Orders: `order_hash`, `condition_id`, `is_taker_order`, `call_position`, `maker`, `signer`, `signature_type`, `token_id`, `side`, `maker_amount`, `taker_amount`, `salt`, `signed_at`, `metadata`, `builder`, `maker_amount_filled`, `taker_amount_filled`, `fee`.
- Position changes and ledger: `kind`, `wallet`, `condition_id`, `token_id`, `shares_delta`, `usdc_delta`, `zeroes_position`; the ledger adds `fee_usdc`.
- Conditions: `prepared_block`, `prepared_at`, `history_complete`. Resolutions: `payout_fraction`, `resolved_block`, `resolved_at`.
- Markets: `market_id`, `question`, `slug`, `event_id`, `event_title`, `neg_risk`, `outcomes`, `end_date`, `is_sports`, `sports_market_type`, `series_slug`, `game_start_time`. Tokens: `condition_id`, `outcome_index`, `outcome`, `complement_token_id`, `market_id`, `event_id`, `neg_risk`, `protocol` (`ctf`).

## Invariants

Each model's header cites its rules in `catalog/protocols/polymarket/NOTES.md` (Q1 to Q12) and `catalog/vendors/polymarket/NOTES.md`.

- Fills (Q1, Q2): side 0 is a buy, which gives pUSD (`makerAmountFilled`) for shares; any other side is a sell. `usdc` is before fees and `fee_usdc` stays apart. The taker order has its own fill, whose taker is the exchange (`is_taker_order`); it repeats the maker fills' volume. In a mint or merge match each fill keeps its own token and price. Amounts are base units over 1e6, kept at 6 places.
- Orders (Q12): a fill matches an order of its `matchOrders` call on maker, token, taker-or-maker order and fill amount; when two orders tie on all four, the nth by call position is the nth by `log_index`. A fill with no match keeps its row with the order's columns null, which their `not_null` tests catch. `signed_at` is the signed order's millisecond `timestamp`.
- Position changes (Q4 to Q7): only the one event that names a user counts. `ctf.*` and `neg_risk.*` events count when their stakeholder is not in `polymarket_contracts` (collateral roles aside), and `ctf.*` only at the top level and on the collateral behind the condition's tokens. `collateral_adapter.*` and `auto_redeemer.*` events count, but only those the `kind` case lists: `collateral_adapter.PositionSplit`, `PositionsMerged`, `PositionsRedeemed` and `PositionsConverted`, and `auto_redeemer.BinaryRedemption` and `NegRiskRedemption`. Any other event gets a null `kind` and drops out (unit test `unknown_events_book_nothing`). A split or merge whose index sets do not cover every outcome gives no row. Each event gives a cash row (`token_id` and `shares_delta` null) and a row per token (`usdc_delta` null). A conversion burns NO of each question whose bit is set and pays YES of the others, with its cash split evenly over the NO conditions. A condition missing from `int_polymarket_outcome_tokens` drops out, cash too.
- Ledger: every fill books to the order's maker, the taker order's own fill too. A buy gains shares and pays `usdc + fee_usdc`; a sell gives up shares and gets `usdc - fee_usdc`. A fill of a token missing from Gamma drops out. Rows from one log can tie, so a running total over the ledger needs a `range` frame (`transformation/CLAUDE.md`).
- Conditions: `history_complete` holds when `prepared_block` is at or after the coverage start, the greater of the lowest blocks in `stg_polygon__polymarket_ctf` and `stg_polygon__polymarket_ctf_exchange_v2` (which keeps only the exchange raw table's `kind = 'log'` rows), and is false while either table is empty.
- Resolutions: `payout_fraction` is the outcome's numerator over the sum of `payout_numerators`.
- Markets and tokens: only Gamma `protocol_version = 'v1'` rows with a condition (markets) or `clob_token_ids` (tokens). When Gamma lists a condition in several markets, the market with the lowest numeric id wins. Each model picks among the rows it keeps, so when that market has no `clob_token_ids`, `int_polymarket_outcome_tokens` keeps a different market than `int_polymarket_markets`. `outcome_index` is the position in `clobTokenIds` from 0, matching index set `1 << i` (Q6).
- Tests in `_int_polymarket__models.yml`: `unique` and `not_null` on each model's key above (resolutions on `condition_id || ':' || outcome_index`); enforced contracts on every model but the orders model; `accepted_values` on the fills' `side` and on `kind` in the position changes and the ledger; 35 unit tests. Singular tests `tests/polymarket_orders_never_fill_past_posted.sql`, `tests/polymarket_signed_orders_agree_per_hash.sql` and `tests/polymarket_position_changes_name_no_contract.sql` read these models.

## Side Effects

- Builds four views and four tables in the `analytics` schema (`DBT_SCHEMA`), the tables as listed in the overview.
- Runs `set local enable_nestloop = off` before each model, which lasts only for that model's transaction.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run polymarket --select int_polymarket_wallet_ledger` builds the model and runs its tests.
