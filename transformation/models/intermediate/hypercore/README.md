# intermediate/hypercore

## Overview

HyperCore fills with three rules added: the signed size, the notional and which side was the taker. `hypercore_fills` reads it ([marts/hypercore](../../marts/hypercore/README.md)). `transformation/dbt_project.yml` builds it as a view (`intermediate: +materialized: view`), so it shows as its own step in Dagster.

## Interface

| Model | Grain and key | Reads | Read by |
|---|---|---|---|
| `int_hypercore_fills` | One fill, one user's side of one trade; `id` (`<block>:<fillIndex>`) | `stg_hypercore__fills` | `hypercore_fills` |

Columns: every staging column (`id`, `block_number`, `block_timestamp`, `fill_index`, `user_address`, `coin`, `px`, `sz`, `side`, `fill_time`, `start_position`, `dir`, `closed_pnl`, `tx_hash`, `oid`, `crossed`, `fee`, `builder_fee`, `tid`, `cloid`, `fee_token`, `builder`, `twap_id`, `_loaded_at`), plus `signed_size`, `notional` and `is_taker`.

## Invariants

The rules come from `catalog/protocols/hypercore/NOTES.md`, as the header of `int_hypercore_fills.sql` says:

- `signed_size` is `sz` for side `B` and `-sz` for side `A`. Any other side gets null, not a guessed sign, and the mart's `not_null` test on `signed_size` fails on it. Unit test `signed_size_is_sz_for_a_buy_and_minus_sz_for_a_sell`.
- `notional` is `px * sz`, in the coin's quote asset, which may not be USD: HIP-3 coins may quote in another collateral, and the fills do not say which. Unit test `notional_is_px_times_sz_on_both_sides`.
- `is_taker` is `crossed`: of a trade's two fills, the crossed one is the taker. Unit test `the_crossed_fill_is_the_taker`.
- The folder declares no data tests (`_int_hypercore__models.yml` holds only unit tests). `hypercore_fills` tests the grain.

## Side Effects

- A dbt build creates or replaces the view in `DBT_SCHEMA` (`analytics`). It copies no rows.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up, build the view with its mart and run its tests: `uv run --project orchestration bj run hypercore`.
