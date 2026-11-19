# Macros

## Overview

The dbt project's Jinja macros. They fall into four groups: the window and token scoping that analyses read, shared aggregations that two or more analyses of one question call, test helpers, and the build settings and maintenance for mart tables and raw-table indexes.

## Interface

### Windows and token scope, for analyses

- `window.sql`
  - `window_bound(chain, index)`: block `index` (0 first, 1 last) of `var('window')[chain]`. `bj answer` passes `var('window')` by chain, from `question.yaml`'s `window`, or its `eval_window` under `--eval`.
  - `window_start(chain)`, `window_end(chain)`: `window_bound(chain, 0)` and `window_bound(chain, 1)`.
  - `in_window(column, chain)`: `<column> between <window_start> and <window_end>`.
- `token_transfers.sql`, over `var('token')` from `dbt_project.yml` or a question's `parameters.token`:
  - `token_transfers(relation=none)`: a `union all` over `var('token').windows` of the rows of `relation` (default `ref('erc20_transfers')`) with that window's `chain`, its lowercased `token` and `block_number` inside its `blocks`.
  - `token_bridge_transfers()`: rows of `ref('bridge_transfers')` whose `ethereum_token` is `var('token').ethereum`, lowercased, on a window's chain and inside its blocks.
  - `token_unit()`: `power(10::numeric, var('token').decimals)`.

### Shared aggregations

- `attributed_eth_flows.sql`: `attributed_eth_flows(attribution, chain, from_block, to_block, code_also_at)`. One row per address in `ref('address_attributions')` with that `attribution` on `chain`: top-level native flows from `ref('wallet_transactions')` over the blocks, and the state from `ref('account_states')` at `state_block`, the latest block at or before `to_block` that has reads. Columns: `address`, `state_block`, `sent_txs`, `sent_failed_txs`, `sent_value_wei`, `sent_fees_wei`, `sent_out_wei`, `blob_fees_wei`, `received_txs`, `received_wei`, `balance_wei`, `nonce`, `code_kind`, `has_code`, `active`. Called by the `binance_hack_fbi_eth_2026_11_01*` analyses and their reference test.
- `labelled_flows.sql`: `labelled_flows_daily(entity, chain, assets, counterparties, from_block, to_block)`. Daily flows of `entity`'s labelled wallets from `ref('labelled_wallet_flows')`, in long form: `day`, `token`, `counterparty`, `metric`, `amount`. `assets` is a list of `[token, asset]` pairs, where `asset` is `'native'` or a token address. Metrics: `inflow`, `outflow`, `net`, `inflow_transfers`, `outflow_transfers`, and for counterparty `all` also `intra` and `intra_transfers`. Called by the `mexc_labelled_flows_2026_11*` analyses and their reference test.

### Test helpers

- `erc20_balance_pairs.sql`: `erc20_balance_pairs()`. Pairs of consecutive readings in `ref('stg_ethereum__erc20_balances')` per wallet and token: `wallet`, `token`, `from_block`, `to_block`, `balance_change`. It covers each interval in `var('coverage')['ethereum.erc20_transfers']` (`verified_ranges`, or `covered`), from the block before the interval, for the coverage filter's `tokens` and, when given, `wallets`. Called by `tests/erc20_transfers_match_balances.sql` and `tests/erc20_transfers_match_balances_has_pairs.sql`.
- `reference_mismatches.sql`: `reference_mismatches(expected, actual, key, value, tolerance_kind, tolerance)`. The rows where the CTE `actual` and the reference seed `expected` disagree, with the `key` columns, `expected`, `actual` and `reason`: `duplicate_in_expected`, `duplicate_in_actual`, `missing_in_actual`, `missing_in_expected` or `over_tolerance`. Called by every test in `tests/reference/`; `seeds/reference/README.md` shows one.

### Mart builds and raw-table indexes

- `reconcile.sql`
  - `fact_config(keys, indexes=[])`: the config of the marts `erc20_transfers`, `dex_trades`, `oracle_prices` and `token_prices`. `var('fact_strategy')` picks `table` (the default: a table build, then `analyze`) or `reconcile` (`reconcile_config`). `var('fact_indexes')` keeps `indexes` only when it is the YAML boolean `true`.
  - `reconcile_config(keys, indexes=[])`: an incremental model with `incremental_strategy='reconcile'` and `unique_key=keys`, which locks first and adds the key and indexes after.
  - `get_incremental_reconcile_sql(arg_dict)`: the `reconcile` strategy dbt calls. It deletes the mart rows whose key left the new result, then merges the rest, updating only rows that changed.
  - Helpers: `reconcile_lock()`, `reconcile_has_index(relation, columns, unique=False)`, `reconcile_key(relation=this)`, `reconcile_indexes(relation=this)`.
- `index_state_readings.sql`: `index_state_readings(family)`, run by hand as `dbt run-operation index_state_readings --args '{family: address_code}'`. Families: `address_code` (`arbitrum_address_code`, `base_address_code`) and `account_state` (`ethereum_account_state`). `index_state_relation(relation, expressions)` builds one index.

## Invariants

- An analysis takes its blocks from `window_start`, `window_end` or `in_window`, or, for the token analyses, from `var('token').windows` through `token_transfers()` and `token_bridge_transfers()`. `orchestration/tests/test_analysis_rules.py` fails when an analysis's SQL writes a bound of its question's `window` or `eval_window`; it lets other block numbers stay. Without `var('window')` for the chain, the bound compiles to `'no window for <chain>: run bj answer'::bigint`: the SQL compiles, as CI needs, and fails when run, so no number comes from the wrong blocks.
- `token_transfers` and `token_bridge_transfers` lowercase the configured token before they compare it.
- `attributed_eth_flows`: `sent_value_wei` and `received_wei` count successful transactions only; `sent_fees_wei` counts every transaction the address sent, reverted ones too. Blob fees stay out of `sent_out_wei`. Internal transfers are in neither. `has_code` is null when a code read at `code_also_at` or `state_block` has not loaded and none found code.
- `labelled_flows_daily`: amounts are whole tokens, multiplied by `10^-decimals` rather than divided, since numeric division rounds to about 16 significant digits. Native assets use 18 decimals; a token missing from `ref('tokens')` gets null amounts. `net` is `inflow - outflow` and leaves out `intra` moves between the entity's own wallets. Only days with at least one flow appear.
- `erc20_balance_pairs`: with no coverage for `ethereum.erc20_transfers` it returns no rows, so the coverage tests compare nothing in a plain build. `bj answer` passes `var('coverage')` (`orchestration/pipeline/cli/answer.py:run_dbt_tests`). Readings with a null `balance` are skipped, and no pair crosses a gap between two intervals.
- `reference_mismatches`: `tolerance_kind` must be `absolute` or `relative`, or compilation fails. A relative tolerance is a share of the expected value, and counts as absolute where that value is 0. A null on one side only is over any tolerance. A key on two rows of one side is a mismatch of its own.
- `fact_config`: `fact_strategy` must be `table` or `reconcile`, and `fact_indexes` a YAML boolean, or compilation fails.
- `get_incremental_reconcile_sql` raises without a `unique_key`. It checks the whole new result (key columns `not null`, a unique index) before it changes the mart table. A `numeric` column whose scale changes counts as changed.
- `index_state_readings` raises on an unknown family and skips a raw table that does not exist. It raises if its index name already belongs to another table.

## Side Effects

- The window, token, aggregation and test-helper macros only emit SQL. They read marts, seeds and staging views when the calling model, analysis or test runs.
- `reconcile.sql`, through each `fact_config` mart's hooks: `analyze` on the table after each build. Under `fact_strategy: reconcile` it also takes `pg_advisory_xact_lock` on the mart, creates a unique index on the key, sets the key columns `not null`, creates the `reconcile_indexes`, and deletes and merges rows in the mart table in `DBT_SCHEMA`. While the mart has no unique index on its key, it first deletes every row whose key appears more than once, and the merge inserts those keys again.
- `index_state_readings` writes to `RAW_SCHEMA`: it takes `pg_try_advisory_lock`, or, when another session holds that lock, logs a line and skips the index without waiting or failing. With the lock it runs `create index concurrently` for an index named `bj_state_<md5>`, drops an invalid one left by an interrupted build with `drop index concurrently`, runs `analyze`, then unlocks. It changes no rows and blocks no ingestion writes. Nothing runs it on a schedule or as a hook.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- `uv run --project orchestration pytest orchestration/tests/test_analysis_rules.py orchestration/tests/test_reconciliation.py orchestration/tests/test_incremental_facts.py orchestration/tests/test_state_indexes.py` covers `window.sql`, `erc20_balance_pairs`, `reconcile.sql` and `index_state_readings`.
