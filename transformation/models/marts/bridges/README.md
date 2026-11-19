# marts/bridges

## Overview

Token bridge moves between an L2 and Ethereum, and the pairs of a withdrawal from one L2 and a deposit into another that it can have paid for. This folder is the `bridges` pipeline: its entry in `PIPELINES` in `orchestration/pipeline/schedules.py` (cron `0 6 * * *`) makes a Dagster job that builds these marts and everything upstream of them, ingestion included. Marts build as tables (`marts: +materialized: table` in `transformation/dbt_project.yml`). The per-bridge models are in [intermediate/bridges](../../intermediate/bridges/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `bridge_transfers` | One bridge move; `(chain, id)` | `int_arbitrum_token_bridge_transfers`, `int_base_op_standard_bridge_transfers` |
| `bridge_pairs` | One withdrawal paired with one deposit; `withdrawal_id`, `deposit_id` | `bridge_transfers` |

Columns:

- `bridge_transfers`: `chain`, `id`, `direction` (`to_ethereum` for a withdrawal, `from_ethereum` for a deposit), `l2_address`, `ethereum_address`, `ethereum_token`, `l2_token`, `amount`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`.
- `bridge_pairs`: `from_chain`, `from_address`, `ethereum_address`, `to_chain`, `to_address`, `ethereum_token`, `amount`, `withdrawal_id`, `withdrawn_at`, `withdrawal_tx_hash`, `deposit_id`, `deposited_at`, `deposit_tx_hash`, `candidates`.

## Invariants

- `bridge_transfers.sql`: `amount` is in the token's base units. Each bridge's intermediate model brings its rows in one shape, so a new bridge adds one branch.
- `bridge_pairs.sql`, per `catalog/protocols/arbitrum-token-bridge/NOTES.md`: a withdrawal and a deposit pair when they share the Ethereum address, token and amount, sit on different chains, and the deposit comes at least the withdrawal chain's finality delay later: 6.4 days from Arbitrum, 1 day from Base. Withdrawals and deposits are numbered in time order within one chain, Ethereum address, token and amount, and the nth withdrawal pairs with the nth deposit on another chain. With two chains each is used once. With a third, one withdrawal could pair with a deposit on each of the other two, and the `unique` tests on `withdrawal_id` and `deposit_id` would fail the build until the pairing chooses between them.
- `candidates` counts the withdrawals from other chains ready by the deposit's time that could have paid for it. The pairing infers; the Ethereum side would prove it.
- `_bridges__models.yml`: `unique` on `chain || ':' || id` of `bridge_transfers`; `accepted_values` on `direction`; `not_null` on `direction`, `l2_address`, `ethereum_address` and `amount`; `unique` and `not_null` on `withdrawal_id` and `deposit_id` of `bridge_pairs`. Unit test `a_late_deposit_of_the_same_amount_pairs`.

## Side Effects

- Builds two tables, `bridge_transfers` and `bridge_pairs`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run bridges --select bridge_pairs` builds the mart and runs its tests.
