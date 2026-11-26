# marts/tokens

## Overview

Each token's latest name, symbol and decimals, one row per chain and token in `evm-erc20-metadata`'s `addresses.json`. This folder is the `tokens` pipeline: `orchestration/pipeline/schedules.py` makes a Dagster job of it (cron `0 6 * * *`) that builds this mart and everything upstream of it, ingestion included. The mart builds as a table (`marts: +materialized: table` in `transformation/dbt_project.yml`). The per-chain readings are in [intermediate/tokens](../../intermediate/tokens/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `tokens` | One token on one chain; `(chain, token)` | `int_ethereum_erc20_metadata`, `int_arbitrum_erc20_metadata`, `int_base_erc20_metadata` |

Columns: `chain`, `token` (the contract address, lowercased), `name`, `symbol`, `decimals`, `block_number` (the block of the reading).

## Invariants

- `tokens.sql` keeps, per `(chain, token)`, the reading with the highest `block_number`; when two readings share a block, the most recently loaded one wins.
- Symbols are not unique, even on one chain: key on `chain` and `token`, never on `symbol`.
- `name` and `symbol` are what `name()` and `symbol()` returned, as text, with a bytes32 reply decoded without its zero bytes; null when the call reverted or returned nothing. A null `decimals` means the contract has no `decimals()`; never assume 18.
- Each chain's intermediate model brings its rows in one shape, so a new chain adds one branch.
- `_tokens__models.yml`: `unique` on `chain || ':' || token`; `not_null` on `chain` and `token`; `accepted_values` on `chain` (`ethereum`, `arbitrum`, `base`).

## Side Effects

- Builds the table `tokens` in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run tokens --select tokens` builds the mart and runs its tests.
