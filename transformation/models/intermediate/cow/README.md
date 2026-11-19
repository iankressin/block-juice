# intermediate/cow

## Overview

CoW Protocol ETH Flow orders, GPv2Settlement trades and ERC-20 transfers into followed wallets on Ethereum, split out of the one raw table the `evm-cow-ethflow` source loads. `cow_ethflow_orders` joins them ([marts/cow](../../marts/cow/README.md)). `transformation/dbt_project.yml` builds them as views (`cow: +materialized: view`), so each shows as its own step in Dagster.

## Interface

| Model | Grain | Reads |
|---|---|---|
| `int_ethereum_cow_ethflow_orders` | One `OrderPlacement` log; `tx_hash`, `log_index` | `stg_ethereum__cow_ethflow` (`event = 'OrderPlacement'`), `stg_ethereum__cow_ethflow_traces` |
| `int_ethereum_cow_trades` | One `Trade` log; `tx_hash`, `log_index` | `stg_ethereum__cow_ethflow` (`event = 'Trade'`) |
| `int_ethereum_cow_wallet_transfers` | One `Transfer` log; `tx_hash`, `log_index` | `stg_ethereum__cow_ethflow` (`event = 'Transfer'`) |

Columns:

- `int_ethereum_cow_ethflow_orders`: `chain`, `block_number`, `block_timestamp`, `transaction_index`, `tx_hash`, `log_index`, `owner`, `eth_flow`, `order_uid`, `eth_value_wei`, `sell_token`, `buy_token`, `receiver`, `sell_amount`, `buy_amount`, `fee_amount`, `partially_fillable`.
- `int_ethereum_cow_trades`: `chain`, `block_number`, `block_timestamp`, `transaction_index`, `tx_hash`, `log_index`, `settlement`, `owner`, `sell_token`, `buy_token`, `sell_amount`, `buy_amount`, `fee_amount`, `order_uid`.
- `int_ethereum_cow_wallet_transfers`: `chain`, `block_number`, `block_timestamp`, `transaction_index`, `tx_hash`, `log_index`, `token`, `from_address`, `to_address`, `amount`.

## Invariants

- `int_ethereum_cow_ethflow_orders.sql`: `order_uid` is the 56-byte GPv2 UID: the order hash `createOrder` returned (32 bytes), then the ETH Flow contract, which owns every ETH Flow order (20), then the order's `validTo` as 8 hex digits (4). `eth_value_wei` is the `createOrder` call's value.
- A placement pairs with a successful call (`error is null and output is not null`) in the same transaction, to the same contract, from the same sender, by position: the nth placement by `log_index` takes the nth call in trace order. The model casts the jsonb `trace_address` to an `int[]`, so calls sort element by element as numbers, a parent before its children: `[2]` before `[10]`. A placement with no such call keeps its row with `order_uid` and `eth_value_wei` null. Unit tests `an_ethflow_order_uid_is_hash_owner_and_valid_to` and `ethflow_placements_pair_with_calls_in_trace_order` (`_int_cow__models.yml`).
- The pairing trusts that the calls run in the same order as their logs. That holds while each `createOrder` call that loads also left its `OrderPlacement` in the receipt. A call that succeeded inside a frame that later reverted breaks it: its trace has a null `error` and an `output`, but its log was rolled back, so every later placement in that transaction takes the call before its own.
- `int_ethereum_cow_trades.sql`: `sell_amount` includes `fee_amount`, as GPv2Settlement emits it. The source loads each Trade in a transaction that also sent an ERC-20 Transfer into a followed wallet, so other traders' trades in the same settlement are here too.
- All amounts are in token base units.
- The folder declares no data tests. `cow_ethflow_orders` tests the grain, and its `not_null` test on `order_uid` fails on a placement whose call did not load.

## Side Effects

- Builds three views, `int_ethereum_cow_ethflow_orders`, `int_ethereum_cow_trades` and `int_ethereum_cow_wallet_transfers`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run cow --select int_ethereum_cow_ethflow_orders` builds the model and runs its tests.
