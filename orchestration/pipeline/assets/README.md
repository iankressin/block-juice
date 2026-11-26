# Assets

The Dagster assets that load and build the warehouse. `ingestion.py` makes one asset per entry in `ingestion/sources.json`, each of which runs one source, and gives each a `no_dead_letters` check. `dbt.py` makes one multi-asset that builds the dbt project and writes the build to the run log. `pipeline/definitions.py` and `pipeline/schedules.py` read both files.

## Interface

- `ingestion.py:ingestion_assets`: one asset per source, keyed `[<name>, <table>]`, in group `ingestion`. dagster-dbt keys the matching dbt source the same way, which is how Dagster links a raw table to its staging model.
- `ingestion.py:ingestion_checks`: one `no_dead_letters` check per ingestion asset.
- `ingestion.py:build_ingestion_asset(source, table)` and `ingestion.py:build_dead_letter_check(source, table)`: the factories behind the two lists.
- `ingestion.py:ENTRIES`, `SOURCES`, `PACKAGES`: the entries of `ingestion/sources.json`, the `(name, table)` pairs, and the package for each pair.
- `ingestion.py:package_dir(source, table)`: the folder `ingestion/sources/<package>` for a pair.
- `ingestion.py:run_ingestion_process(command, *, cwd, env, log, monitor)`: starts a process, streams its output into the Dagster log and returns `(returncode, errors_tail, stderr_tail)`.
- `ingestion.py:parse_log_line(line)`: turns one pino JSON line into a log level and message. Any other line logs at INFO as it is.
- `ingestion.py:read_process_log` and `ingestion.py:kill_ingestion_process`: helpers for `run_ingestion_process`.
- `dbt.py:transformation_assets`: the `@dbt_assets` multi-asset over `transformation/`, one asset per model. It needs a `DbtCliResource` named `dbt`, which `definitions.py` supplies.

## Invariants

- An ingestion asset key is exactly `[<name>, <table>]` from `sources.json` (`ingestion.py:build_ingestion_asset`). Rename one side and Dagster loses the link to the dbt source.
- `sources.json` is read at import time (`ingestion.py:ENTRIES`), and `pipeline.sources.read_sources` raises `BadInput` on a bad file, so a bad file stops the definitions from loading.
- An ingestion asset fails with `dg.Failure` when the process exits nonzero, and attaches the error and stderr tails as metadata (`ingestion.py:build_ingestion_asset`).
- `no_dead_letters` has severity WARN, so it never blocks a run. It passes when pending plus parked dead letters is 0 (`ingestion.py:build_dead_letter_check`).
- `ingestion.py:LOG_CHARS_MAX` (64 KiB) caps each line read and each tail kept. On stdout only lines at ERROR or above go into the failure tail. An oversized line swaps the tail for a notice and the raw stdout tail (`ingestion.py:read_process_log`).
- stdout and stderr are read on two threads so a full pipe can't block the process. On any exception the process group is killed before the threads are joined (`ingestion.py:run_ingestion_process`).
- `dbt.py:build_models` calls dbt with `raise_on_error=False`, kills a dbt process that is still running, and writes the run log before it raises any dbt error. A failed build still leaves its rows in the run log.
- Each ingestion run holds an `ingestion` warehouse slot and each dbt build a `dbt` slot (`pipeline.concurrency.warehouse_slot`).

## Side Effects

- Each ingestion asset runs `pnpm --silent ingest` in `ingestion/sources/<package>`, with the whole environment plus `DAGSTER_RUN_ID` (the Dagster run id) and `CHAIN` (the source name) (`ingestion.py:build_ingestion_asset`).
- `ingestion.py:kill_ingestion_process` sends SIGKILL to the process group on POSIX.
- `no_dead_letters` counts rows in `<RAW_SCHEMA>._dead_letters` for `source_table = '<name>_<table>'` through `pipeline.warehouse.count_dead_letters`. With no such table it reports 0 and 0.
- `dbt.py:build_models` runs `dbt build` and calls `pipeline.run_log.record_dbt_build`, which writes `ops.dbt_invocations`, `ops.dbt_node_runs` and `ops.dbt_node_versions`.
- `pipeline.concurrency.warehouse_slot` takes a Postgres advisory lock for each slot it holds.

## Verification

- Run: `uv run --project orchestration pytest orchestration/tests/test_definitions.py orchestration/tests/test_ingestion_process.py orchestration/tests/test_concurrency.py orchestration/tests/test_cli_new_source.py`
- All tests: `uv run --project orchestration pytest`
