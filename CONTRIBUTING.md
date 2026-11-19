# Contributing

Each folder with code has a README that lists what it exports, the rules its code keeps and what it changes outside itself. Start from the layer you are changing. The [code map](README.md#code-map) links the four layers, and each layer's README links the folders under it.

`catalog/` (protocol and vendor facts), `answers/` (one folder per question), `examples/` and `docs/` hold no code.

## Rules across layers

- A source's `name` and `table` equal its dbt source and table. Dagster links the ingestion asset `[<name>, <table>]` to its staging view by that pair.
- Sources extract and load only. Joins, sign rules, units, prices and aggregation live in dbt, so a wrong rule is fixed in SQL and rebuilt without fetching again.
- Each protocol version on each chain gets its own source and raw table, and marts union the per-version models.
- Every asset belongs to a scheduled pipeline, and every analysis to exactly one question.

## What it writes

- Postgres: `raw.<name>_<table>` plus `_dead_letters`, `_checkpoints` and the Pipes cursor table `_sync` in `RAW_SCHEMA` (`raw`); models in `DBT_SCHEMA` (default `analytics`); the run log in `ops` (`ops.ingestion_runs`, `ops.dbt_invocations`, `ops.dbt_node_runs`, `ops.pipeline_runs`).
- Files: `answers/<slug>/` from `bj answer`, `answers/<slug>/reports/` from `bj report` (`--format gdoc` also uploads a Google Doc to Drive), `ingestion/sources.json` from `pnpm -C ingestion generate-sources`, and `infra/grafana/dashboards/ingestion.json` and `pipeline.json` from `infra/grafana/build_dashboards.py`.
- Metrics: ingestion gauges to the Pushgateway, read by Grafana.

## Checks

Run the checks for each layer you changed. CI runs the same ones on every pull request.

- `pnpm -C ingestion typecheck` and `pnpm -C ingestion --filter @ingestion/<package> test`
- `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- `uv run --project orchestration bj questions --check`
- `uv run --project orchestration pytest`
