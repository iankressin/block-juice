# Grafana

The Grafana dashboards and their provisioning. The `grafana` service in `infra/docker-compose.yml` mounts `provisioning/datasources/`, `provisioning/dashboards/` and `dashboards/` read-only. `build_dashboards.py` writes two of the dashboards and `check_dashboards.py` runs every query on a live Grafana.

## Interface

- `build_dashboards.py`: run `python3 infra/grafana/build_dashboards.py` with no arguments. It writes `dashboards/ingestion.json` (`ingestion_dashboard`) and `dashboards/pipeline.json` (`pipeline_dashboard`). `Dashboard` lays out panels on a 24-column grid; `prom`, `sql`, `override` and `thresholds` build targets and field settings.
- `check_dashboards.py:main`: run `python3 infra/grafana/check_dashboards.py [--grafana URL] [--hours 24]`. `--grafana` defaults to the local compose Grafana. It prints, per dashboard, how many queries returned data, came back empty or failed.
- `dashboards/ingestion.json`: title Ingestion, uid `ingestion`, Prometheus only. Generated.
- `dashboards/pipeline.json`: title Pipeline, uid `pipeline`, with a `run` variable read from `ops.pipeline_runs` and a run annotation. Generated.
- `dashboards/erpc.json` (uid `erpc_metrics`) and `dashboards/dshackle.json`: copied from the eRPC and Dshackle releases. `infra/docker-compose.yml` has the command that refreshes each.
- `provisioning/datasources/prometheus.yml`: datasource Prometheus, uid `prometheus`, the default.
- `provisioning/datasources/warehouse.yml`: datasource Warehouse, uid `warehouse`, type `grafana-postgresql-datasource`, user `monitor`.
- `provisioning/dashboards/dashboards.yml`: one file provider that loads `dashboards/`.

## Invariants

- `dashboards/ingestion.json` and `dashboards/pipeline.json` are generated and don't say so. Edit `build_dashboards.py` and run it; never edit the JSON. Grafana can't save provisioned dashboards from the UI.
- The generated dashboards name their datasources by uid (`build_dashboards.py:PROM`, `PG`): `prometheus` and `warehouse` must match the provisioning files. `dshackle.json` also uses `prometheus`.
- `pipeline_dashboard` reads `ops.pipeline_runs`, `ops.ingestion_runs`, `ops.dbt_invocations` and `ops.dbt_node_runs` (from `infra/postgres/ops.sql`), plus `pg_stat_user_tables` and `pg_stat_statements`. A renamed column there breaks its panels. It also reads Prometheus: postgres-exporter series such as `pg_database_size_bytes` and `pg_stat_user_tables_*`, and eRPC series such as `erpc_upstream_request_total`. `THIS_RUN_INGESTION` and `THIS_RUN_DBT` match the selected run on `dagster_run_id`, or the run or invocation id without one.
- `ingestion_dashboard` reads the `ingestion_*` metrics that runs push to the Pushgateway, labelled by `source` and `table`. A source's last success turns orange after 25 hours and red after 49.
- `check_dashboards.py` fails (exit 1) when a query errors. An empty result is reported but passes. It also exits nonzero, with a traceback, when it cannot reach Grafana or a dashboard uid is not found.
- Nothing in CI or `orchestration/tests/` runs either script.

## Side Effects

- `build_dashboards.py` overwrites `dashboards/ingestion.json` and `dashboards/pipeline.json`. Grafana picks them up within a minute.
- `check_dashboards.py` reads `dashboards/*.json` for the uids, then calls the Grafana HTTP API to fetch each dashboard and run its queries, which reach Prometheus and the warehouse through Grafana. It writes nothing.
- Grafana fills `warehouse.yml` from the env vars `WAREHOUSE_DB` and `MONITOR_PASSWORD` when it loads it.

## Verification

- After editing `build_dashboards.py`: run it, then `git diff infra/grafana/dashboards/` to review the change.
- With the stack up (`docker compose up -d`): `python3 infra/grafana/check_dashboards.py`
- No pytest covers this folder.
