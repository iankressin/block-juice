# Base staging

## Overview

Typed views over the five raw tables that the Base sources load. Each view reads one raw table, casts its fields out of `data` and lowercases EVM addresses. There are no joins and no rules here: those live in `models/intermediate/`.

## Interface

`_base__sources.yml` declares the dbt source `base` in schema `RAW_SCHEMA` (default `raw`). Each table's name is the ingestion source's `table`, and its identifier is the raw table `base_<table>`.

| Model | Reads | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- |
| `stg_base__erc20_transfers` | `raw.base_erc20_transfers` | `evm-erc20-transfers` | Transfer log of a token in its `chains/base/addresses.json` | `int_base_erc20_transfers` | transfers |
| `stg_base__address_code` | `raw.base_address_code` | `evm-address-code` | address and block read with `eth_getCode` | `int_base_address_code` | labels, transfers |
| `stg_base__op_standard_bridge` | `raw.base_op_standard_bridge` | `evm-op-standard-bridge` | `ERC20BridgeInitiated` or `ERC20BridgeFinalized` log of Base's L2StandardBridge | `int_base_op_standard_bridge_transfers` | bridges |
| `stg_base__chainlink_price_feeds` | `raw.base_chainlink_price_feeds` | `evm-chainlink-price-feeds` | `AnswerUpdated` log of an aggregator in its `addresses.json` | `int_base_chainlink_prices` | prices |
| `stg_base__erc20_metadata` | `raw.base_erc20_metadata` | `evm-erc20-metadata` | token and block read | `int_base_erc20_metadata` | tokens |

Columns, as each `.sql` file selects them. Every view also has `id` and `_loaded_at`.

- `stg_base__erc20_transfers`: `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `token`, `from_address`, `to_address`, `value` (token base units).
- `stg_base__address_code`: `block_number`, `address`, `code`.
- `stg_base__op_standard_bridge`: `event`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `contract`, `local_token`, `remote_token`, `from_address`, `to_address`, `amount` (token base units). Field meanings are in `catalog/protocols/op-standard-bridge/NOTES.md`.
- `stg_base__chainlink_price_feeds`: `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `aggregator`, `answer` (an integer in the feed's decimals), `aggregator_round_id`, `updated_at`.
- `stg_base__erc20_metadata`: `block_number`, `token`, `name`, `symbol`, `decimals`.

## Invariants

- `id` is `unique` and `not_null` on each raw table (`_base__sources.yml`) and on each view (`_base__models.yml`).
- The source name and table name match the ingestion source's `name` and `table` (comment in `_base__sources.yml`). Dagster keys the ingestion asset `[base, <table>]`, the same key dbt gives the source, and that is how the two link.
- Every EVM address column goes through `lower()`. Amounts stay in base units.
- `stg_base__erc20_transfers`: `block_number`, `tx_hash` and `token` are `not_null`.
- `stg_base__address_code`: `address` and `code` are `not_null`. `code` is `'0x'` when the address has none.
- `stg_base__op_standard_bridge`: `event` is in `accepted_values` `[ERC20BridgeInitiated, ERC20BridgeFinalized]` and `amount` is `not_null`.
- `stg_base__chainlink_price_feeds`: `answer` and `aggregator` are `not_null`. A `relationships` test (severity `warn`) checks `aggregator` against the seed `chainlink_feeds`. An aggregator missing there drops its rounds out of `oracle_prices`.
- `stg_base__erc20_metadata`: `token` is `not_null`. `name`, `symbol` and `decimals` are null when the call reverted or returned nothing at that block. Never assume 18 decimals.

## Side Effects

- A dbt build creates or replaces each model as a view in `DBT_SCHEMA` (`analytics`), since `dbt_project.yml` sets `staging: +materialized: view`. The views read the raw tables live and copy no rows.
- Nothing here writes to `RAW_SCHEMA`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up, build one view and run its tests: `uv run --project orchestration bj run <pipeline> --select <model>`, with the pipeline from the table above, such as `bj run bridges --select stg_base__op_standard_bridge`.
