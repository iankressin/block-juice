# intermediate/transfers

## Overview

ERC-20 Transfer logs on Ethereum, Arbitrum and Base, one model per chain and source, in the shape `erc20_transfers` or `erc20_wallet_flows` reads ([marts/transfers](../../marts/transfers/README.md)). Each model adds a `chain` column to its staging view and drops `_loaded_at`. `transformation/dbt_project.yml` builds them as views (`transfers: +materialized: view`), so each chain shows as its own step in Dagster.

## Interface

| Model | Grain and key | Reads |
|---|---|---|
| `int_ethereum_erc20_transfers` | One Transfer log; `id` | `stg_ethereum__erc20_transfers` |
| `int_arbitrum_erc20_transfers` | One Transfer log; `id` | `stg_arbitrum__erc20_transfers` |
| `int_base_erc20_transfers` | One Transfer log; `id` | `stg_base__erc20_transfers` |
| `int_arbitrum_erc20_wallet_transfers` | One Transfer log into or out of a wallet `evm-erc20-wallet-transfers` follows; `id` | `stg_arbitrum__erc20_wallet_transfers` |

All four give the columns `chain`, `id`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `token`, `from_address`, `to_address`, `value`.

## Invariants

- `value` is in the token's base units.
- `id` is the log's place on its chain, so it is unique within one chain only; across chains the key is `(chain, id)`.
- `_int_transfers__models.yml`: `unique` and `not_null` on `id` of all four models.

## Side Effects

- Builds four views, `int_ethereum_erc20_transfers`, `int_arbitrum_erc20_transfers`, `int_base_erc20_transfers` and `int_arbitrum_erc20_wallet_transfers`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run transfers --select int_ethereum_erc20_transfers` builds the model and runs its tests.
