# intermediate/bridges

## Overview

Token bridge moves between an L2 and Ethereum, one model per bridge, in the shape `bridge_transfers` reads ([marts/bridges](../../marts/bridges/README.md)). `transformation/dbt_project.yml` builds them as views (`bridges: +materialized: view`), so each bridge shows as its own step in Dagster.

## Interface

| Model | Grain and key | Reads |
|---|---|---|
| `int_arbitrum_token_bridge_transfers` | One gateway log; `id` | `stg_arbitrum__token_bridge`, seed `arbitrum_token_gateways` |
| `int_base_op_standard_bridge_transfers` | One bridge log; `id` | `stg_base__op_standard_bridge` |

Both give the columns `id`, `chain`, `direction`, `l2_address`, `ethereum_address`, `ethereum_token`, `l2_token`, `amount`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`.

## Invariants

- `direction` is `to_ethereum` for a withdrawal (`WithdrawalInitiated` on Arbitrum, `ERC20BridgeInitiated` on Base) and `from_ethereum` for a deposit (`DepositFinalized`, `ERC20BridgeFinalized`). A withdrawal goes from the L2 user `from` to the Ethereum address `to`; a deposit the other way. The rules come from `catalog/protocols/arbitrum-token-bridge/NOTES.md` and `catalog/protocols/op-standard-bridge/NOTES.md`.
- `int_arbitrum_token_bridge_transfers.sql` keeps only logs whose `contract` is in the `arbitrum_token_gateways` seed, since any contract can emit these events. It drops a `WithdrawalInitiated` whose `from_address` is the gateway itself: a deposit the gateway could not mint, sent back, that no user started. Its events name only the Ethereum token, so `l2_token` is null.
- `int_base_op_standard_bridge_transfers.sql` takes `ethereum_token` from `remote_token` and `l2_token` from `local_token`.
- `amount` is in the token's base units.
- `_int_bridges__models.yml`: `unique` and `not_null` on `id` of both models. Unit tests `an_arbitrum_withdrawal_goes_from_the_l2_user_to_ethereum`, `only_gateway_logs_become_arbitrum_bridge_moves` and `a_base_deposit_goes_from_ethereum_to_the_l2_user`.

## Side Effects

- Builds two views, `int_arbitrum_token_bridge_transfers` and `int_base_op_standard_bridge_transfers`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run bridges --select int_arbitrum_token_bridge_transfers` builds the model and runs its tests.
