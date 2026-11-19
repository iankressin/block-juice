# Postgres

The SQL that sets up the warehouse. `init.sql` prepares the server and includes `ops.sql`, which creates the run log in the `ops` schema. The one-shot `warehouse-init` service in `infra/docker-compose.yml` runs `init.sql` with psql on every `docker compose up`, once the warehouse is healthy.

## Interface

`init.sql` (a psql script):

- Database `erpc`, created when missing, for the eRPC cache.
- Extension `pg_stat_statements`, read by the Pipeline dashboard. The server must preload it, which `infra/docker-compose.yml` does.
- Role `monitor`: can log in, reads every table and stat (`pg_monitor`, `pg_read_all_data`) and defaults to read-only transactions. Grafana's Warehouse datasource and the `postgres-exporter` service connect as it. Its password comes from the psql variable `monitor_password`.
- `\ir ops.sql` last.

`ops.sql` (plain SQL), schema `ops`:

- `ops.ingestion_runs`: one row per source run, keyed by `run_id`, with `dagster_run_id`, `source`, `table_name`, start and finish times, `succeeded`, `records_written`, `failed_calls`, `retried_calls`, `load_seconds`, `dead_letters_pending`, `dead_letters_parked` and `error`. Indexed on `started_at` and `dagster_run_id`.
- `ops.dbt_invocations`: one row per dbt build, keyed by `invocation_id`, with `dagster_run_id`, `command`, start and finish times, `succeeded`, `dbt_version` and `error`. Indexed on `started_at` and `dagster_run_id`.
- `ops.dbt_node_runs`: one row per model, test, seed or snapshot a build selected, keyed by `(invocation_id, unique_id)`, with `resource_type`, `name`, `status`, times, `execution_seconds`, `rows_affected`, `failures` and `message`.
- `ops.dbt_node_versions`: the hashes behind each built node, keyed by `(invocation_id, unique_id)`, in the jsonb `provenance`.
- `ops.pipeline_runs` (view): one row per Dagster run, keyed by `run_key` (`dagster_run_id`, or the run or invocation id without one). It joins the ingestion runs and dbt builds of that run into a status and counts of sources, records, failed calls, models built and tests passed, warned and failed.

## Invariants

- Both files run on every `docker compose up`, so every statement must be safe to rerun: `IF NOT EXISTS`, guarded `CREATE DATABASE` and `CREATE ROLE`, and `CREATE OR REPLACE VIEW`. `orchestration/tests/test_model_versions.py` runs `ops.sql` twice.
- These are not migrations. A changed column on an existing table never reaches a warehouse that already has the table, and `CREATE OR REPLACE VIEW` fails when a change drops or retypes a view column.
- `ops.sql` stays plain SQL with no psql commands, because PGlite runs it in the ingestion tests (`ingestion/lib/src/warehouse/pglite.fixture.ts`) and psycopg2 runs it in one call (`orchestration/pipeline/demo.py:load_fixture`). `init.sql` needs psql for `\gexec`, `\ir` and its variable.
- In `init.sql`, `SET pg_stat_statements.track_utility = off` comes before `ALTER ROLE`, so the statement that sets the password is not recorded.
- `ops.dbt_node_runs` references `ops.dbt_invocations`, and `ops.dbt_node_versions` references `ops.dbt_node_runs`, both `ON DELETE CASCADE`. The tables come in that order, and the view last.
- Writers insert without `ON CONFLICT`, so a repeated id fails the insert.
- `dead_letters_pending` and `dead_letters_parked` are null when a run failed before counting. `started_at` and `finished_at` in `ops.dbt_node_runs` are null for skipped nodes, and `rows_affected` is null for views, tests and ephemeral models.
- Writers: `ingestion/lib/src/warehouse/index.ts` (`recordRun`, called by `runSource`) writes `ops.ingestion_runs`; `orchestration/pipeline/run_log.py:record_dbt_build` writes the three dbt tables. In the `bj demo` warehouse, `orchestration/pipeline/demo.py` writes instead: `load_fixture` writes `ops.ingestion_runs` and `record_build` the three dbt tables. Readers: `orchestration/pipeline/analysis/executor.py` (freshness and model builds) and the Grafana Pipeline dashboard.

## Side Effects

- `init.sql` can create the `erpc` database and the `monitor` role, creates the extension when missing, resets the `monitor` password to the current `MONITOR_PASSWORD`, grants its roles again, then applies `ops.sql`.
- `ops.sql` creates the schema, tables and indexes when missing and replaces the `ops.pipeline_runs` view. It never drops or alters a table or its rows.
- The factory build workflow (`.github/workflows/factory-build.yml`) runs `ops.sql` on its Postgres service. `bj demo` and the PGlite test fixture run it too.

## Verification

- Run: `uv run --project orchestration pytest orchestration/tests/test_model_versions.py orchestration/tests/test_run_log.py`. The Postgres tests run only with `WAREHOUSE_*` set.
- Ingestion side: `pnpm -C ingestion --filter @ingestion/lib test`
