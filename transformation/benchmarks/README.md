# Benchmarks

## Overview

Two Python scripts that time dbt models on synthetic rows, so a change to how a model builds can be measured before it ships. Neither runs in CI, in Dagster or in `bj`. `docs/fact-model-performance.md` and `docs/model-performance.md` hold the results and the reasons behind them.

## Interface

- `facts.py`: compares four ways of building the `erc20_transfers` mart and prints one JSON report.
  - Arguments: `--rows` (default 200,000; at least 20,000) and `--repeats` (default 3; at least 1).
  - Env: `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER`, `WAREHOUSE_PASSWORD`. It ignores `WAREHOUSE_DB`.
  - Strategies, one schema each (`bench_<strategy>`): `baseline` (the model without its `fact_config` line), `table`, `indexed` (`fact_indexes: true`) and `reconcile` (`fact_strategy: reconcile`).
  - Scenarios: `no_op`, and `correct_100`, which rewrites `value` on 100 raw rows before each repeat. The report holds node seconds, their median, and insert, update and delete counts on the mart table, from `pg_stat_user_tables`.
  - Plans: `token_window_plan` per strategy, and `dex_window_before_index` and `dex_window_after_index` from a typed fixture (`benchmark_dex`) with the same predicate as the UNI swap analyses.
  - Functions: `run`, `tuples`, `explain`, `seed_raw`, `benchmark_dex`, `benchmark`, `main`.
- `state_models.py`: times models at a baseline commit against the working tree, one JSON line per measurement.
  - Arguments: `--baseline-ref` (default `fc873ce`, which must exist in the local checkout) and `--case`: `all` (default), `bridge`, `candles`, `gamma`, `deployments`, `address_code` or `snapshots`.
  - Env: `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER`, `WAREHOUSE_PASSWORD`, `WAREHOUSE_DB`.
  - Cases and the models they time:

    | Case | Model | Compares |
    | --- | --- | --- |
    | `bridge` | `marts/bridges/bridge_pairs.sql` | baseline and current, at 1,000 and 5,000 rows a side |
    | `candles` | `marts/polymarket/polymarket_price_candles.sql` | baseline and current, at 10,000 and 100,000 fills |
    | `gamma` | `marts/polymarket/polymarket_markets.sql` | baseline and current, at 1,000 and 10,000 markets |
    | `deployments` | `intermediate/deployments/int_ethereum_deployment_state_gas.sql` | baseline and current, at 100 and 1,000 transactions of 100 traces |
    | `address_code` | `intermediate/labels/int_base_address_code.sql` | without and with an index on the raw rows |
    | `snapshots` | `marts/balances/latest_balances.sql`, `marts/tokens/tokens.sql`, `intermediate/accounts/int_ethereum_account_states.sql` | without and with an index on the raw rows |

  - Functions: `render`, `measure`, and one per case: `bridge`, `candles`, `gamma`, `deployments`, `address_code`, `snapshots`.

## Invariants

- `facts.py` never touches an existing database. It creates `bj_benchmark_<12 hex digits>`, works on a copy of `transformation/` in a temporary folder (leaving out `target`, `logs`, `dbt_packages` and `__pycache__`), and drops the database `with (force)` in a `finally` block. It edits `erc20_transfers.sql` and `dbt_project.yml` in that copy only.
- `facts.py` rotates the order of the strategies on each repeat, so a host that gets busier during the run does not favour one strategy.
- `state_models.py` creates only temporary tables, views and indexes, and rolls back after each case. Each case runs under `statement_timeout='90s'`, `jit=off` and `work_mem='4MB'`, and the `candles`, `gamma` and `deployments` cases also set `enable_nestloop=off`.
- `state_models.py` renders each model with plain Jinja, giving it only `ref` (which returns the bare model name), `config` and, for staging models, `source`. A model it times must render with those alone.
- `state_models.py` runs each model's SQL three times with `explain (analyze, buffers, format json)` and reports the median, so compare medians, not one run.

## Side Effects

- `facts.py` needs `CREATEDB` on the server. It creates and drops one database, and inside it the schemas `raw` and `bench_<strategy>` and the raw tables `ethereum_erc20_transfers`, `arbitrum_erc20_transfers` and `base_erc20_transfers` (only the Ethereum one gets rows), plus the table `bench_table.dex_index_fixture` and an index on it. It runs dbt through `dbtRunner` and sets `WAREHOUSE_DB`, `RAW_SCHEMA` and, per strategy, `DBT_SCHEMA` in its own process's environment.
- `state_models.py` connects to `WAREHOUSE_DB` and runs `git show <baseline-ref>:transformation/models/<path>` in the repo. Its relations are temporary, so they vanish with the session.
- Both print to stdout and write no files.

## Verification

- `facts.py`: `uv run --project orchestration python transformation/benchmarks/facts.py --rows 200000 --repeats 3 > fact-benchmark.json`, against a throwaway PostgreSQL server with `CREATEDB`.
- `state_models.py`: `uv run --project orchestration python transformation/benchmarks/state_models.py --baseline-ref fc873ce --case all > state-models.jsonl`, against a test PostgreSQL server.
- No pytest covers these scripts.
