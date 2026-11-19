# intermediate/deployments

## Overview

The EIP-8037 state gas of each Ethereum contract-deployment transaction, in the shape `deployment_state_gas` reads ([marts/deployments](../../marts/deployments/README.md)). `transformation/dbt_project.yml` builds the model as a view (`deployments: +materialized: view`), so it shows as its own step in Dagster.

## Interface

| Model | Grain and key | Reads |
|---|---|---|
| `int_ethereum_deployment_state_gas` | One transaction with at least one counted create; `tx_hash` | `stg_ethereum__contract_deployments` (traces), `stg_ethereum__contract_deployments_transactions`, `stg_ethereum__contract_deployments_state_diffs` |

Columns: `block_number`, `block_timestamp`, `transaction_index`, `tx_hash`, `from_address`, `to_address`, `sighash`, `transaction_type`, `deployers` (the addresses that ran the creates), `creates`, `new_accounts`, `code_bytes`, `new_slots`, `state_gas`, `rule_version`.

## Invariants

The rules are in the header of `int_ethereum_deployment_state_gas.sql`:

- A create counts when its trace has `trace_type = 'create'`, neither it nor any frame above it has an `error`, and its transaction has `status = 1`. A transaction with no counted create has no row.
- `code_bytes` is the length in bytes of the runtime code each counted create deployed.
- A create's account is new unless a non-storage state diff of the transaction shows the address before it (`diff_kind` `'*'` or `'-'`). An address the diffs do not list, created and deleted in the transaction, counts as new. Value transfers to new accounts that are not contracts are left out.
- `new_slots` counts the storage slots, of every address the transaction touched, whose `prev` is zero or absent and whose `next` is nonzero, whatever the diff's kind.
- `state_gas = cost_per_state_byte * (120 * new_accounts + code_bytes + 64 * new_slots)`, with the Jinja constant `cost_per_state_byte = 1530` from EIP-8037 as in Last Call in November 2026. It is a lower bound: the gas the constructor runs on, calldata, intrinsic gas, EIP-8038's changes and EIP-7702 authorizations are left out. `rule_version` names the rule and the constant.
- `_int_deployments__models.yml`: `unique` and `not_null` on `tx_hash`. Unit test `deployment_counts_standing_creates_accounts_and_slots`, built on transaction `0xf0747bd0…41f6` in block 26367346 and made-up cases.

## Side Effects

- Builds the view `int_ethereum_deployment_state_gas` in the `analytics` schema (`DBT_SCHEMA`). Unlike the deployments mart, this folder sets no `enable_nestloop` pre-hook.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run deployments --select int_ethereum_deployment_state_gas` builds the model and runs its tests.
