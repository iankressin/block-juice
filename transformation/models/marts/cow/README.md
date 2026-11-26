# marts/cow

## Overview

CoW Protocol ETH Flow orders placed by the wallets `evm-cow-ethflow` follows, with the settlement that filled each one. This folder is the `cow` pipeline: `orchestration/pipeline/schedules.py` makes a Dagster job of it (cron `0 6 * * *`) that builds this mart and everything upstream of it, ingestion included. The mart builds as a table (`marts: +materialized: table` in `transformation/dbt_project.yml`). The models it joins are in [intermediate/cow](../../intermediate/cow/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `cow_ethflow_orders` | One ETH Flow order; `(chain, order_uid)` | `int_ethereum_cow_ethflow_orders`, `int_ethereum_cow_trades`, `int_ethereum_cow_wallet_transfers` |

Columns: `chain`, `order_uid`, `block_number`, `block_timestamp`, `tx_hash`, `owner`, `eth_flow`, `eth_value_wei`, `sell_token`, `buy_token`, `receiver`, `sell_amount`, `buy_amount`, `fee_amount`, `partially_fillable`, `settled`, `trades`, `settlement_tx_hash`, `settlement_block_number`, `settlement_block_timestamp`, `settlement`, `executed_sell_amount`, `executed_buy_amount`, `executed_fee_amount`, `received_amount`.

`wallet_eth_outflows` in the `accounts` pipeline reads this mart.

## Invariants

- `cow_ethflow_orders.sql`: an order is `settled` when a GPv2Settlement Trade carries its `order_uid` in a later transaction than the order's: a later block, or the same block at a higher transaction index. The `executed_*` columns sum those Trades, `trades` counts them, and the `settlement_*` columns name the first.
- `received_amount` is the buy token the settlement contract sent the order's receiver in those transactions, from the Transfers into followed wallets. It is null when not settled, and 0 when nothing came or the receiver is not a followed wallet.
- An order with no such Trade is not settled: still open, expired, refunded or invalidated, which this mart does not tell apart.
- Amounts are in token base units; `eth_value_wei` is in wei.
- `_cow__models.yml`: `unique` on `chain || ':' || order_uid`; `not_null` on `chain`, `order_uid`, `tx_hash`, `owner` and `settled`; `accepted_values` `[ethereum]` on `chain`. A null `order_uid` means the `createOrder` call did not load.

## Side Effects

- Builds the table `cow_ethflow_orders` in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run cow --select cow_ethflow_orders` builds the mart and runs its tests.
