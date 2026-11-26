# marts/balances

## Overview

Each wallet's latest balance of each asset, on Ethereum, Solana and Bitcoin. This folder is the `balances` pipeline: `orchestration/pipeline/schedules.py` makes a Dagster job of it (cron `0 6 * * *`) that builds this mart and everything upstream of it, ingestion included. The mart builds as a table (`marts: +materialized: table` in `transformation/dbt_project.yml`). The per-chain models are in [intermediate/balances](../../intermediate/balances/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `latest_balances` | One wallet and asset on one chain; `(chain, wallet, asset)` | `int_ethereum_balances`, `int_solana_balances`, `int_bitcoin_balances` |

Columns: `chain`, `wallet`, `asset_type` (`native`, `erc20` or `spl`), `asset` (`'eth'`, `'sol'`, `'btc'`, or the token or mint address), `block_number` (the block, or Solana slot, of the reading), `balance`.

## Invariants

- `latest_balances.sql` keeps, per `(chain, wallet, asset)`, the reading with the highest `block_number`; when two readings share a block, the most recently loaded one wins.
- `balance` is in the asset's base units: wei, lamports, satoshis or token base units.
- Each chain's intermediate model brings its rows in one shape, so a new chain adds one branch to the union.
- `_balances__models.yml`: `accepted_values` on `chain` (`ethereum`, `solana`, `bitcoin`) and on `asset_type`; `not_null` on `wallet`, `asset_type`, `asset`, `block_number` and `balance`. `tests/latest_balances_one_row_per_wallet_asset.sql` fails when a chain, wallet and asset has more than one row.

## Side Effects

- Builds the table `latest_balances` in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run balances --select latest_balances` builds the mart and runs its tests.
