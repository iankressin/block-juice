# Polymarket staging

## Overview

One typed view over the raw table of Polymarket's Gamma markets, the off-chain metadata for v1 and v2 markets alike. It casts the market's fields out of `data` and the event fields out of `data -> 'events' -> 0`. There are no joins and no rules here: those live in `models/intermediate/polymarket/`. Field types are in `catalog/vendors/polymarket/NOTES.md`.

## Interface

`_polymarket__sources.yml` declares the dbt source `polymarket` in schema `RAW_SCHEMA` (default `raw`), with the table `markets` (identifier `polymarket_markets`).

| Model | Reads | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- |
| `stg_polymarket__markets` | `raw.polymarket_markets` | `polymarket-markets` | Gamma market, keyed by `market_id` | `int_polymarket_markets`, `int_polymarket_outcome_tokens`, `int_polygon_polymarket_ctf_position_changes`, the mart `polymarket_markets` | polymarket |

Columns: `market_id`, `condition_id`, `question_id`, `question`, `slug`, `event_id`, `event_slug`, `event_title`, `outcomes` (text array), `clob_token_ids` (numeric array), `neg_risk`, `neg_risk_market_id`, `protocol_version` (Gamma's `version`, `v1` or `v2`), `start_date`, `end_date`, `closed`, `created_at`, `updated_at`, `sports_market_type`, `game_start_time`, `series_slug`, `fee_type`, `_loaded_at`. The view has no `id` column; `market_id` is Gamma's `id`.

## Invariants

- `id` is `unique` and `not_null` on the raw table (`_polymarket__sources.yml`); `market_id` is `unique` and `not_null` on the view (`_polymarket__models.yml`).
- `clob_token_ids[i]` is the token of `outcomes[i]`. Both come from strings that hold JSON and keep their order through `with ordinality`.
- Token ids are uint256, so `numeric`.
- A placeholder neg-risk market has an empty `conditionId` and no `clobTokenIds`. It keeps its row, with null `condition_id` (`nullif(..., '')`) and null `clob_token_ids` (`array_agg` over no elements).
- A missing `negRisk` counts as false (`coalesce(..., false)`).
- `condition_id`, `question_id` and `neg_risk_market_id` go through `lower()`. Empty strings in the date, sports and series fields become null.
- Three unit tests in `_polymarket__models.yml` pin the output on real Gamma market objects from 2026-11-08: `v1_market_stages_with_outcomes_tokens_and_event` (a resolved v1 binary market), `v2_market_stages_with_protocol_version` (an open v2 market with no `questionID` and no `negRisk`) and `placeholder_market_keeps_its_row`.
- The source name and table name match the ingestion source's `name` and `table` (comment in `_polymarket__sources.yml`), which is how Dagster links the ingestion asset `[polymarket, markets]` to the dbt source.

## Side Effects

- A dbt build creates or replaces the view in `DBT_SCHEMA` (`analytics`), since `dbt_project.yml` sets `staging: +materialized: view`. It reads the raw table live and copies no rows.
- Nothing here writes to `RAW_SCHEMA`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run polymarket --select stg_polymarket__markets` builds the view and runs its tests. To run only the unit tests, pass `test --select stg_polymarket__markets,test_type:unit` to the dbt command above in place of `parse`, with `DBT_SCHEMA` set to a check schema of your own (`analytics_<name>_check`).
- `transformation/tests/polymarket_resolved_markets_are_zero_sum.sql` reads `stg_polymarket__markets`.
