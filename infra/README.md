# Infra

## Overview

Settings for the local Docker stack that `bj dev` starts with `docker compose up -d`: the Postgres warehouse, the one-shot `warehouse-init`, eRPC, Dshackle, `postgres-exporter`, Prometheus, the Pushgateway and Grafana. Only `grafana/` and `postgres/` hold code. `dshackle/` and `erpc/` hold one YAML settings file each, `prometheus/` holds two (`prometheus.yml` and `alerts.yml`), and `docker-compose.yml` sits beside them.

## Subdirectories & Boundaries

- grafana: [./grafana/README.md](./grafana/README.md) - Dashboards and provisioning. `build_dashboards.py` generates `dashboards/ingestion.json` and `pipeline.json`; `check_dashboards.py` runs every dashboard query against a live Grafana.
- postgres: [./postgres/README.md](./postgres/README.md) - Warehouse setup SQL. `init.sql` creates the `erpc` database, `pg_stat_statements` and the read-only `monitor` role, then includes `ops.sql`, which creates the `ops` run log and the `ops.pipeline_runs` view.
- dshackle, erpc, prometheus: settings files only, no contract.
