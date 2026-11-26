# marts/accounts

## Overview

Wallet transactions, native outflows, account state reads and published address attributions. This folder is the `accounts` pipeline: `orchestration/pipeline/schedules.py` makes a Dagster job of it (cron `0 6 * * *`) that builds these marts and everything upstream of them, ingestion included. Marts build as tables (`marts: +materialized: table` in `transformation/dbt_project.yml`). The intermediate models are in [intermediate/accounts](../../intermediate/accounts/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `wallet_transactions` | One top-level transaction from or to a followed wallet; `(chain, tx_hash)` | `int_ethereum_wallet_transactions` |
| `wallet_eth_outflows` | One successful top-level transaction with value, from its sender; `(chain, tx_hash)` | `wallet_transactions`, `cow_ethflow_orders` (the `cow` pipeline's mart), seeds `stablecoins`, `cex_addresses` |
| `account_states` | One address and block an account-state source read; `(chain, address, block_number)` | `int_ethereum_account_states` |
| `address_attributions` | One address a public body ties to an incident; `(chain, address, attribution)` | seed `attributed_addresses` |

Columns:

- `wallet_transactions`: `chain`, `block_number`, `block_timestamp`, `transaction_index`, `tx_hash`, `from_address`, `to_address`, `value_wei`, `succeeded`, `tx_type`, `gas_used`, `effective_gas_price`, `fee_wei`, `blob_fee_wei`.
- `wallet_eth_outflows`: `chain`, `block_number`, `block_timestamp`, `transaction_index`, `tx_hash`, `from_address`, `to_address`, `value_wei`, `eth`, `outflow_class`, `venue`, `order_uid`, `settlement_tx_hash`, `settlement_block_number`, `buy_token`, `buy_symbol`, `received_amount`.
- `account_states`: `chain`, `address`, `block_number`, `balance_wei`, `nonce`, `code`, `code_kind`.
- `address_attributions`: `chain`, `address` (lowercased), `published_address` (as published), `attribution`, `attributed_by`, `published`.

`wallet_transactions` is also read by `labelled_wallet_flows` in the `transfers` pipeline.

## Invariants

- `wallet_transactions.sql`: amounts are in wei. `value_wei` moved only when `succeeded` is true; `from_address` pays `fee_wei` and `blob_fee_wei` either way. Internal transfers, which only traces show, are not here.
- `wallet_eth_outflows.sql` gives each outflow exactly one `outflow_class`:
  - `sold`: the transaction placed a CoW Protocol ETH Flow order whose receiver is the sender, a later settlement filled it, its buy token is in the `stablecoins` seed and the settlement sent that token to the sender. `venue` is `CoW Protocol`.
  - `sent_to_exchange`: `to_address` is in the `cex_addresses` seed, whose exchange name goes in `venue`.
  - `sent_out`: every other outflow.
- `wallet_eth_outflows` is complete only for wallets that both `wallet_transactions` and `evm-cow-ethflow` follow: a wallet whose ETH Flow orders did not load has every order as `sent_out`. The fee is never part of an outflow. `eth` is `value_wei / 1e18`.
- `account_states.sql`: a read that has not loaded is null. `code_kind` is `none`, `eip7702_delegation` or `contract`.
- `wallet_transactions` and `account_states` each select from one intermediate model per chain, so a new chain adds one branch. `wallet_eth_outflows` reads marts and `address_attributions` a seed. Today every mart holds Ethereum only.
- `_accounts__models.yml`: `unique` on each grain above; `not_null` on the grain's columns, on `from_address` and `value_wei` of both transaction marts, and on `block_number`, `succeeded` and `fee_wei` of `wallet_transactions`; `accepted_values` `[ethereum]` on `chain` of `wallet_transactions`, `account_states` and `address_attributions`; `not_null` and `accepted_values` on `outflow_class` (`sold`, `sent_to_exchange`, `sent_out`); `accepted_values` on `code_kind`. Unit test `an_outflow_is_sold_only_with_a_stablecoin_settlement_back`.

## Side Effects

- Builds four tables, `wallet_transactions`, `wallet_eth_outflows`, `account_states` and `address_attributions`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run accounts --select wallet_eth_outflows` builds the mart and runs its tests.
