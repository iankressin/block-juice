# intermediate/labels

## Overview

Each Arbitrum and Base address's latest code reading and what kind of code it is, in the shape `address_labels` reads ([marts/labels](../../marts/labels/README.md)). There is one model per chain. `transformation/dbt_project.yml` builds them as views (`labels: +materialized: view`), so each chain shows as its own step in Dagster.

## Interface

| Model | Grain and key | Reads |
|---|---|---|
| `int_arbitrum_address_code` | One address; `address` | `stg_arbitrum__address_code` |
| `int_base_address_code` | One address; `address` | `stg_base__address_code` |

Both give the columns `chain`, `address`, `code_block` (the block of the latest reading) and `code_kind`.

## Invariants

- The latest reading of an address, by `block_number`, wins (`distinct on (address)`).
- `code_kind` is `none` for code `0x`, `eip7702_delegation` for code matching `^0xef0100[0-9a-f]{40}$` (an EOA that delegates under EIP-7702), and `contract` for any other code.
- `_int_labels__models.yml`: `unique` and `not_null` on `address`; `accepted_values` on `code_kind` (`none`, `eip7702_delegation`, `contract`) for both models. Unit test `code_kinds_follow_eip_7702`.

## Side Effects

- Builds two views, `int_arbitrum_address_code` and `int_base_address_code`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run labels --select int_base_address_code` builds the model and runs its tests.
