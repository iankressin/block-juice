# Polygon staging

## Overview

Typed views over the two raw tables of Polymarket's contracts on Polygon: the conditional-token contracts and CTF Exchange v2. Each view casts the ABI-decoded arguments out of `data -> 'args'` into one column per argument and lowercases addresses. There are no joins and no rules here: those live in `models/intermediate/polymarket/`. Field meanings are in `catalog/protocols/polymarket/NOTES.md`.

## Interface

`_polygon__sources.yml` declares the dbt source `polygon` in schema `RAW_SCHEMA` (default `raw`), with the tables `polymarket_ctf` and `polymarket_ctf_exchange_v2` (identifiers `polygon_polymarket_ctf`, `polygon_polymarket_ctf_exchange_v2`).

| Model | Reads | Kind | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- | --- |
| `stg_polygon__polymarket_ctf` | `raw.polygon_polymarket_ctf` | all rows | `polygon-polymarket-ctf` | log of ConditionalTokens, the NegRiskAdapter, pUSD's collateral adapters or the auto-redeemers | `int_polygon_polymarket_ctf_conditions`, `int_polygon_polymarket_ctf_position_changes`, `int_polygon_polymarket_ctf_resolutions` | polymarket |
| `stg_polygon__polymarket_ctf_exchange_v2` | `raw.polygon_polymarket_ctf_exchange_v2` | `log` | `polygon-polymarket-ctf-exchange-v2` | `OrderFilled` of one of the three CTF Exchange v2 contracts | `int_polygon_polymarket_ctf_conditions`, `int_polygon_polymarket_ctf_exchange_v2_fills`, `int_polygon_polymarket_ctf_exchange_v2_orders` | polymarket |
| `stg_polygon__polymarket_ctf_exchange_v2_txs` | `raw.polygon_polymarket_ctf_exchange_v2` | `transaction` | `polygon-polymarket-ctf-exchange-v2` | transaction an `OrderFilled` came from | `int_polygon_polymarket_ctf_exchange_v2_orders` | polymarket |

Columns. Every view has `id`, `block_number`, `block_timestamp`, `tx_hash` and `_loaded_at`.

- `stg_polygon__polymarket_ctf`: `event`, `log_index`, `contract`, `condition_id`, `oracle`, `question_id`, `outcome_slot_count`, `payout_numerators` (numeric array), `stakeholder`, `initiator`, `from_address`, `collateral_token`, `parent_collection_id`, `index_sets` (numeric array), `amount`, `amount_out`, `amounts` (numeric array), `payout`, `neg_risk_market_id`, `index_set`, `fee_bips`, `question_index`, `outcome`. A column is null where the event has no such argument.
- `stg_polygon__polymarket_ctf_exchange_v2`: `event`, `log_index`, `contract`, `order_hash`, `maker`, `taker`, `side`, `token_id`, `maker_amount_filled`, `taker_amount_filled`, `fee`, `builder`, `metadata`.
- `stg_polygon__polymarket_ctf_exchange_v2_txs`: `tx_from`, `tx_to`, `function_name`, `condition_id`, `args` (jsonb, the decoded call's arguments, signed orders included), `input` (the call as sent).

## Invariants

- `id` is `unique` and `not_null` on each raw table (`_polygon__sources.yml`) and on each view (`_polygon__models.yml`).
- `event` is the catalog's key, such as `ctf.PositionSplit`, not the bare event name. `ctf`, `neg_risk` and `collateral_adapter` each emit a `PositionSplit`, two of them with the same topic0. `accepted_values` on `stg_polygon__polymarket_ctf.event` lists the 18 keys it allows; `stg_polygon__polymarket_ctf_exchange_v2.event` allows only `ctf_exchange_v2.OrderFilled`.
- `stakeholder` names the wallet in `ctf` and `neg_risk` events (`coalesce` of `stakeholder` and `redeemer`), `initiator` in the adapters' and `from_address` in the auto-redeemers'. `index_sets` holds a split's or merge's `partition` or a redemption's `indexSets`.
- Amounts are in base units, 6 decimals. Token ids are uint256, so `numeric`.
- `stg_polygon__polymarket_ctf_exchange_v2`: `side` is in `[0, 1]`, 0 a buy and 1 a sell for the maker. `block_number`, `block_timestamp`, `tx_hash` and `contract` are `not_null`. A fill whose taker is the exchange itself is the taker order's own fill.
- `stg_polygon__polymarket_ctf_exchange_v2_txs`: `tx_hash` is `unique`. `function_name` is `matchOrders` when the input decoded against the catalog ABI (`accepted_values`); otherwise it is null and `input` holds the call.
- The transactions view is named `_txs`, not `_transactions`: a dbt unit test names its fixture `__dbt__cte__<model>`, and the long name would pass Postgres's 63-character limit.
- The exchange views lowercase `tx_hash`. `stg_polygon__polymarket_ctf` keeps `tx_hash` as the source wrote it.
- The source name and table name match the ingestion source's `name` and `table` (comment in `_polygon__sources.yml`), which is how Dagster links the ingestion assets `[polygon, <table>]` to the dbt sources.

## Side Effects

- A dbt build creates or replaces each view in `DBT_SCHEMA` (`analytics`), since `dbt_project.yml` sets `staging: +materialized: view`. The views read the raw tables live and copy no rows.
- Nothing here writes to `RAW_SCHEMA`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run polymarket --select stg_polygon__polymarket_ctf` builds a view and runs its tests.
- `transformation/tests/polymarket_resolved_markets_are_zero_sum.sql` reads `stg_polygon__polymarket_ctf`.
