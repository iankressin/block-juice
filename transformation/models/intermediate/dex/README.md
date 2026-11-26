# intermediate/dex

## Overview

Uniswap v2, v3 and v4 trades on Ethereum, one model per protocol version, each in the shape `dex_trades` reads ([marts/dex](../../marts/dex/README.md)). Each joins its Swap logs to the pool's creation log and to the Swap's transaction. `transformation/dbt_project.yml` builds them as views (`intermediate: +materialized: view`), so each version shows as its own step in Dagster.

## Interface

| Model | Grain and key | Reads |
|---|---|---|
| `int_ethereum_uniswap_v2_trades` | One Swap that traded; `id` | `stg_ethereum__uniswap_v2` (`PairCreated`, `Swap`), `stg_ethereum__uniswap_v2_transactions` |
| `int_ethereum_uniswap_v3_trades` | One Swap that traded; `id` | `stg_ethereum__uniswap_v3` (`PoolCreated`, `Swap`), `stg_ethereum__uniswap_v3_transactions` |
| `int_ethereum_uniswap_v4_trades` | One Swap that traded; `id` | `stg_ethereum__uniswap_v4` (`Initialize`, `Swap`), `stg_ethereum__uniswap_v4_transactions` |

All three share these columns, with types the contract enforces (`_int_dex__models.yml`): `id`, `chain`, `protocol`, `version`, `pool`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `tx_from`, `sender`, `recipient`, `hooks`, `token_bought`, `amount_bought`, `token_sold`, `amount_sold`.

## Invariants

The rules come from `catalog/protocols/uniswap/NOTES.md`:

- v2: the swapper's change in token X is `amountXOut - amountXIn`, which also holds for a flash swap with both Ins non-zero. `token0` and `token1` come from the pair's `PairCreated`.
- v3: `amount0` and `amount1` are the pool's balance changes, so the swapper's change is their negative. Tokens come from `PoolCreated`.
- v4: `amount0` and `amount1` are already the swapper's changes, the opposite sign to v3. The pool is its `pool_id`; `currency0`, `currency1` and `hooks` come from its `Initialize`. v4 has no recipient, so `recipient` is null.
- In every version, a Swap whose two changes do not have opposite signs traded nothing and is left out, such as a v4 hook's own Swap with both amounts 0. A Swap whose pool creation did not load drops out of the inner join; `tests/uniswap_swaps_have_their_pool.sql` fails when that happens.
- `tx_from` is the Swap transaction's `from_address`, through a left join. `hooks` is null in v2 and v3.
- Amounts are in base units, with no decimals or prices. A token of `0x0000000000000000000000000000000000000000` is native ETH.
- Each model sets `contract: enforced: true`. Tests: `unique` and `not_null` on `id`; `not_null` on `pool`, `block_number`, `tx_hash`, `tx_from`, `token_bought`, `amount_bought`, `token_sold` and `amount_sold`. Unit tests `v2_swapper_gets_out_minus_in_of_each_token_of_the_pair`, `v3_swapper_gets_the_negative_of_the_pools_change` and `v4_swapper_gets_the_amounts_as_emitted`, built on the proof logs in the catalog notes.

## Side Effects

- Builds three views, `int_ethereum_uniswap_v2_trades`, `int_ethereum_uniswap_v3_trades` and `int_ethereum_uniswap_v4_trades`, in the `analytics` schema (`DBT_SCHEMA`).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run dex --select int_ethereum_uniswap_v3_trades` builds the model and runs its tests.
