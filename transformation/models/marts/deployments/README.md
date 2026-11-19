# marts/deployments

## Overview

One contract-deployment transaction per row, with the EIP-8037 state gas its creates and new storage slots would cost, as a lower bound. This folder is the `deployments` pipeline: its entry in `PIPELINES` in `orchestration/pipeline/schedules.py` (cron `0 6 * * *`) makes a Dagster job that builds this mart and everything upstream of it, ingestion included. The rules live in [intermediate/deployments](../../intermediate/deployments/README.md).

`transformation/dbt_project.yml` builds the mart as a table (`marts: +materialized: table`) with the pre-hook `set local enable_nestloop = off`: the views it reads join on jsonb staging columns, and the planner's nested loops took minutes where hash joins take seconds.

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `deployment_state_gas` | One successful transaction with at least one create or create2 that stood; `tx_hash` | `int_ethereum_deployment_state_gas` |

Columns: `chain`, `block_number`, `block_timestamp`, `transaction_index`, `tx_hash`, `from_address`, `to_address`, `sighash`, `transaction_type`, `deployers`, `creates`, `new_accounts`, `code_bytes` (bytes), `new_slots`, `state_gas` (gas), `rule_version`.

## Invariants

- `deployment_state_gas.sql` sets `chain` to `'ethereum'`; the rules are in `int_<chain>_deployment_state_gas`. `state_gas` is a lower bound, and `rule_version` names the rule it follows.
- `_deployments__models.yml`: `unique` and `not_null` on `tx_hash`, which is unique while the mart holds one chain; a second chain makes the grain `(chain, tx_hash)`. `accepted_values` `[ethereum]` on `chain`; `not_null` on `block_number`, `creates`, `new_accounts`, `code_bytes`, `new_slots` and `state_gas`.

## Side Effects

- Builds the table `deployment_state_gas` in the `analytics` schema (`DBT_SCHEMA`).
- Runs `set local enable_nestloop = off` before the build, which lasts only for the model's transaction.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run deployments --select deployment_state_gas` builds the mart and runs its tests.
