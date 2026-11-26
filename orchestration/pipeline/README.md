# Pipeline

The Python package behind Dagster and the `bj` CLI. The files here make the Dagster code location (`definitions.py`, `schedules.py`, `project.py`) and the helpers that the assets and the CLI share: warehouse reads, warehouse slots, the dbt run log, `sources.json` parsing, answer publishing and the demo. `pyproject.toml` points Dagster at `pipeline.definitions`.

## Interface

Child packages:

- [`assets/`](./assets/README.md): the ingestion assets, their `no_dead_letters` checks and the dbt multi-asset.
- [`cli/`](./cli/README.md): the `bj` commands, one module each.
- [`analysis/`](./analysis/README.md): the engine behind `bj answer`.

Files in this folder:

- `definitions.py:defs`: the `dg.Definitions`, with every ingestion asset, `transformation_assets`, the `no_dead_letters` checks, the jobs and schedules from `schedules.py`, and a `DbtCliResource` named `dbt`.
- `schedules.py:PIPELINES`: one entry per `transformation/models/marts/<pipeline>/` folder that holds a model, read by `pipelines()` and mapped to `DEFAULT_CRON` unless `CRON_OVERRIDES` names it. A new pipeline needs no edit here.
- `schedules.py:jobs`, `schedules.py:schedules`: one job per pipeline that builds `path:models/marts/<pipeline>` and everything upstream, ingestion included, plus the `daily` job over all of `path:models/marts`, which selects each shared source and model once.
- `project.py:REPO_ROOT`, `INGESTION_DIR`, `dbt_project`: paths, and the `DbtProject` for `transformation/`.
- `warehouse.py:connect(**options)`: a psycopg2 connection from the `WAREHOUSE_*` settings.
- `warehouse.py:count_dead_letters`, `read_cursor`, `read_coverage`, `read_configuration_cursor`: read one source's dead letters, cursor, coverage and configuration cursor from the raw schema.
- `concurrency.py:warehouse_slot(pool, log)`: holds one of a pool's warehouse slots (`ingestion` or `dbt`) for the length of a run. `concurrency_limit(pool)`, `monitor_slot`, `connect_for_slot`, `DEFAULT_LIMITS` support it.
- `run_log.py:record_dbt_build(log, dagster_run_id, invocation, started_at)`: writes one dbt build to the run log. `dbt_run_rows`, `node_versions`, `record_node_versions`, `DbtInvocation`, `DbtNodeRun` and `WRITES_ROWS` support it; `pipeline/demo.py` reuses them.
- `sources.py:read_sources(text)` and `SourceEntry`: parse and check `ingestion/sources.json` (`SOURCES_FILE`). `SourceEntry.scopes(repo_root)` lists a source's load scopes, the folders of `<settings>/scopes/` that hold an `addresses.json`, sorted by name. It raises `BadInput` for a name that does not match `SCOPE` (`^[a-z0-9][a-z0-9-]*$`).
- `source_config.py:parse_source_env`, `source_env_values`: read a source's `.env` the way the Node `dotenv` package does.
- `answer_artifacts.py:publish(folder, prepared, *, on_published)`: swaps new answer outputs (`OUTPUTS`) into an answer folder and keeps the last set in `previous/`. When the folder held none of `OUTPUTS`, it removes the old `previous/` too, so no last set is kept.
- `demo.py:run(repo_root, output)`: `bj demo`. It loads the synthetic rows in `examples/balances/` into a throwaway Postgres, builds the balance models, answers a question and exports a report.

## Invariants

- An asset key or check that no job in `schedules.py:jobs` selects fails `test_definitions.py`.
- Every entry in `schedules.py:PIPELINES`, and the `daily` job, runs on `DEFAULT_CRON` (`0 6 * * *`), except those `CRON_OVERRIDES` names.
- `concurrency.py:DEFAULT_LIMITS` allows 4 ingestion runs and 1 dbt build at once. `BJ_INGESTION_CONCURRENCY` and `BJ_DBT_CONCURRENCY` override them with an integer from 1 to 64; anything else raises `ValueError` (`concurrency.py:concurrency_limit`).
- `concurrency.py:warehouse_slot` waits with jittered backoff from 0.25 s up to 5 s. When Postgres has no free connections, `connect_for_slot` returns None and the slot waits. `monitor_slot` checks every second that the lock is still held, and cancels the run if it is lost.
- `warehouse.py:connect` needs `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER`, `WAREHOUSE_PASSWORD` and `WAREHOUSE_DB`, and the readers need `RAW_SCHEMA`. Each reader checks that its table exists first and returns an empty result when it doesn't.
- `run_log.py:record_dbt_build` never raises: a failure to write the run log becomes a warning. `ops.dbt_node_versions` is written in a savepoint and skipped when the table doesn't exist, so it never blocks the core rows.
- `run_log.py:dbt_run_rows` records `rows_affected` only for models, seeds and snapshots (`WRITES_ROWS`), and `failures` only for tests.
- `sources.py:read_sources` raises `BadInput` on a bad entry or a repeated `(name, table)` pair.
- `answer_artifacts.py:publish` restores the old outputs and `previous/` when anything fails, then raises again.
- `demo.py:run` raises `BadInput` when the output path exists, Docker is missing, or a step times out. `demo.py:worker` fails unless the checks pass and the answer is exactly `3.75`.

## Side Effects

- `project.py` calls `dbt_project.prepare_if_dev()` at import, which writes the dbt manifest under `dagster dev`.
- `warehouse.py` reads `<RAW_SCHEMA>._dead_letters`, `_sync`, `_coverage` and `_source_configurations`.
- `concurrency.py:warehouse_slot` holds a warehouse connection and a session advisory lock for each slot, and starts a thread that polls `pg_locks`.
- `run_log.py:record_dbt_build` reads dbt's `run_results.json` and `manifest.json`, and inserts into `ops.dbt_invocations`, `ops.dbt_node_runs` and `ops.dbt_node_versions`.
- `answer_artifacts.py:publish` renames files in the answer folder and `previous/`.
- `demo.py:run` starts a `postgres:16` container bound to localhost, runs the demo worker in a child Python process, and removes the container after. The worker runs `infra/postgres/ops.sql`, fills `raw.*` and `ops.*` with synthetic rows (`dagster_run_id` `synthetic-demo`), runs `dbt build` in a temporary copy of `transformation/`, and writes the output folder (default `.demo/<id>`).
- Env vars read: `WAREHOUSE_*`, `RAW_SCHEMA` (`warehouse.py`), `BJ_INGESTION_CONCURRENCY`, `BJ_DBT_CONCURRENCY` (`concurrency.py`), `DAGSTER_HOME` (`demo.py:worker`).

## Verification

- Run: `uv run --project orchestration pytest orchestration/tests/test_definitions.py orchestration/tests/test_scheduling.py orchestration/tests/test_concurrency.py orchestration/tests/test_warehouse.py orchestration/tests/test_run_log.py orchestration/tests/test_model_versions.py orchestration/tests/test_source_config.py orchestration/tests/test_sources_json.py orchestration/tests/test_demo.py`
- All tests: `uv run --project orchestration pytest`
- End to end, with Docker: `uv run --project orchestration bj demo`
