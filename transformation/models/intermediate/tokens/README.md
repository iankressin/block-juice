# intermediate/tokens

## Overview

ERC-20 metadata readings on Ethereum, Arbitrum and Base, one model per chain, in the shape the `tokens` mart reads ([marts/tokens](../../marts/tokens/README.md)). Each model only adds a `chain` column to its staging view. `transformation/dbt_project.yml` builds them as views (`intermediate: +materialized: view`), so each chain shows as its own step in Dagster.

## Interface

| Model | Grain and key | Reads |
|---|---|---|
| `int_ethereum_erc20_metadata` | One metadata reading; `id` | `stg_ethereum__erc20_metadata` |
| `int_arbitrum_erc20_metadata` | One metadata reading; `id` | `stg_arbitrum__erc20_metadata` |
| `int_base_erc20_metadata` | One metadata reading; `id` | `stg_base__erc20_metadata` |

All three give the columns `id`, `chain`, `token`, `name`, `symbol`, `decimals`, `block_number`, `_loaded_at`.

## Invariants

- One token can have several readings here, at different blocks or loads. The mart picks the latest.
- A null `decimals` means the contract has no `decimals()`; never assume 18. Join tokens on `(chain, token)`, never on `symbol` (`transformation/CLAUDE.md`).
- `_int_tokens__models.yml`: `unique` and `not_null` on `id` of all three models.

## Side Effects

- Builds three views, `int_ethereum_erc20_metadata`, `int_arbitrum_erc20_metadata` and `int_base_erc20_metadata`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run tokens --select int_ethereum_erc20_metadata` builds the model and runs its tests.
