# marts/transfers

## Overview

Every ERC-20 transfer the sources loaded on Ethereum, Arbitrum and Base, the same transfers with each side classified, the value movements that touch labelled wallets, and the transfers of followed wallets seen from each side. This folder is the `transfers` pipeline: its entry in `PIPELINES` in `orchestration/pipeline/schedules.py` (cron `0 6 * * *`) makes a Dagster job that builds these marts and everything upstream of them, ingestion included. Since two marts here read marts of other pipelines, that job also builds `wallet_transactions` (`accounts`) and `address_labels` (`labels`) and their inputs. The per-chain models are in [intermediate/transfers](../../intermediate/transfers/README.md).

## Interface

| Mart | Grain | Reads |
|---|---|---|
| `erc20_transfers` | One Transfer log; `(chain, id)` | `int_ethereum_erc20_transfers`, `int_arbitrum_erc20_transfers`, `int_base_erc20_transfers` |
| `classified_transfers` | One transfer between two different addresses; `(chain, id)` | `erc20_transfers`, `address_labels` |
| `labelled_wallet_flows` | One value movement, seen from one labelled entity; `(chain, id, entity)` | `wallet_transactions`, `erc20_transfers`, seed `wallet_labels` |
| `erc20_wallet_flows` | One transfer a wallet source loaded, seen from one side; `(chain, id, wallet, direction)` | `int_arbitrum_erc20_wallet_transfers` |

Columns:

- `erc20_transfers`: `chain`, `id`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `token`, `from_address`, `to_address`, `value`.
- `classified_transfers`: the `erc20_transfers` columns, plus `from_kind`, `from_exchange`, `from_entity`, `from_group`, `to_kind`, `to_exchange`, `to_entity`, `to_group`, `category`.
- `labelled_wallet_flows`: `chain`, `id`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `asset`, `from_address`, `to_address`, `value`, `entity`, `direction`, `wallet`, `counterparty_address`, `counterparty_entity`.
- `erc20_wallet_flows`: the `erc20_transfers` columns, plus `wallet`, `direction` and `counterparty`.

## Invariants

- `erc20_transfers.sql`: `value` is in the token's base units, and `id` is the log's place on its chain, so a row is unique by `chain` and `id`. A new chain adds one branch to the union.
- `erc20_transfers` calls `fact_config(['chain', 'id'], indexes=[{'columns': ['chain', 'token', 'block_number']}])` (`macros/reconcile.sql`). By default (`var('fact_strategy', 'table')`) it builds a table and runs `analyze` after. With `fact_strategy: reconcile` it builds incrementally on `(chain, id)`, still reading its whole input. The index builds only when `fact_indexes` is true. A `fact_strategy` other than `table` or `reconcile`, or a `fact_indexes` that is not a YAML boolean, fails compilation.
- `classified_transfers.sql` leaves out a transfer from an address to itself. A side's kind comes from `address_labels` (`exchange`, `contract`, `eoa`), except `bridge` for the zero address, and `deposit` for an address that is no exchange yet sent every transfer it made on its chain, of any token, to one exchange's addresses. A side with no label is `unknown`. The entity is the exchange for an exchange or deposit address, `bridge:<chain>` for the zero address, and the address otherwise. `category` is the first that fits: `bridge`, `exchange`, `contract`, `p2p` (both EOAs), else `unknown`.
- `labelled_wallet_flows.sql`: a movement is a successful top-level transaction with value from `wallet_transactions` (`asset` `'native'`, `id` `tx:<hash>`, value in wei) or a Transfer from `erc20_transfers` (`asset` is the token). `direction` is `inflow`, `outflow` or `intra`, from the labelled entity's side. A movement between two entities gives one row for each. The flows are complete only for the wallets the sources follow, from their `START_BLOCK` on.
- `erc20_wallet_flows.sql`: each transfer from `evm-erc20-wallet-transfers` gives an `out` row for its sender and an `in` row for its receiver, with the other side as `counterparty` and `value` in base units. Only the wallets in that source's `addresses.json` have complete flows, from its `START_BLOCK` on; a counterparty's rows hold only its transfers with those wallets. A transfer from a wallet to itself gives one row of each direction.
- `_transfers__models.yml`: `unique` on each grain above; `accepted_values` on `chain` (`ethereum`, `arbitrum`, `base`) of `erc20_transfers` and `labelled_wallet_flows`, on `from_kind`, `to_kind` and `category`, and on `direction`; `not_null` on the key and amount columns of `erc20_transfers` and `labelled_wallet_flows`, and on `from_kind`, `to_kind`, `from_entity`, `to_entity` and `category` of `classified_transfers`. `erc20_wallet_flows` has `unique` on its grain, `accepted_values` on `chain` (`arbitrum`) and `direction` (`in`, `out`), and `not_null` on its key, amount, `wallet` and `counterparty`. Unit tests `a_transfer_flows_out_of_its_sender_and_into_its_receiver`, `a_deposit_address_sends_only_to_one_exchange` and `a_labelled_flow_takes_its_direction_and_counterparty`.
- Singular tests: `tests/erc20_transfers_match_balances.sql` (tag `coverage`) checks, on Ethereum only, that between two balance readings of a wallet and token the balance changes by the transfers in minus the transfers out; `tests/erc20_transfers_match_balances_has_pairs.sql` (severity `warn`) warns when it found no pair of readings to compare. It warns only when `var('coverage')` holds `ethereum.erc20_transfers`; without it, it returns no rows.

## Side Effects

- Builds four tables, `erc20_transfers`, `classified_transfers`, `labelled_wallet_flows` and `erc20_wallet_flows`, in the `analytics` schema (`DBT_SCHEMA`), then runs `analyze` on `erc20_transfers`.
- With `fact_strategy: reconcile`, takes a transaction-level advisory lock on `erc20_transfers` (`reconcile_lock`) before it writes, deletes the rows whose key left the new result, merges the rest and keeps the columns in step with the model (`on_schema_change='sync_all_columns'`). After the write, `reconcile_key` adds a unique index on the key and sets its columns `not null`. See [macros](../../../macros/README.md).

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run transfers --select classified_transfers` builds the mart and runs its tests.
