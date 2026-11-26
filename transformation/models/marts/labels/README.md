# marts/labels

## Overview

What kind of address each Arbitrum and Base address is whose code a source read, and the exchange that owns it when one does. This folder is the `labels` pipeline: `orchestration/pipeline/schedules.py` makes a Dagster job of it (cron `0 6 * * *`) that builds this mart and everything upstream of it, ingestion included. The mart builds as a table (`marts: +materialized: table` in `transformation/dbt_project.yml`). The per-chain code readings are in [intermediate/labels](../../intermediate/labels/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `address_labels` | One address on one chain; `(chain, address)` | `int_arbitrum_address_code`, `int_base_address_code`, seed `cex_addresses` |

Columns: `chain`, `address`, `code_block`, `code_kind`, `exchange`, `exchange_label`, `kind`.

`classified_transfers` in the `transfers` pipeline reads this mart.

## Invariants

- `address_labels.sql`: `kind` is `exchange` for an address in the `cex_addresses` seed, whatever its code; otherwise `contract` for an address with code; otherwise `eoa`, which includes EIP-7702 delegated EOAs. The seed's addresses match after `lower()`.
- Each chain's intermediate model brings its rows in one shape, so a new chain adds one branch.
- `_labels__models.yml`: `unique` on `chain || ':' || address`; `not_null` on `chain`, `address` and `kind`; `accepted_values` on `chain` (`arbitrum`, `base`) and `kind` (`exchange`, `contract`, `eoa`). Unit test `an_exchange_label_wins_over_code`.

## Side Effects

- Builds the table `address_labels` in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run labels --select address_labels` builds the mart and runs its tests.
