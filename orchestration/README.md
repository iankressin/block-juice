# Orchestration

## Overview

The Python project (`pyproject.toml`, run with `uv run --project orchestration`) that holds the Dagster code location and the `bj` CLI. Dagster turns each `ingestion/sources.json` entry and each dbt model into an asset, groups them into one job per pipeline and schedules those jobs. `bj` wraps the same pieces for a person or an agent: install, run, answer, check and report. `tests/` holds the pytest suite that ties the layers together.

## Subdirectories & Boundaries

- pipeline: [./pipeline/README.md](./pipeline/README.md) - The package itself: `definitions.py:defs`, `schedules.py:pipelines`, the warehouse slots, the dbt run log and `sources.json` parsing.
  - assets: [./pipeline/assets/README.md](./pipeline/assets/README.md) - One ingestion asset per source, keyed `[<name>, <table>]`, its `no_dead_letters` check, and the dbt multi-asset that writes `ops.dbt_invocations`, `ops.dbt_node_runs` and `ops.dbt_node_versions`.
  - cli: [./pipeline/cli/README.md](./pipeline/cli/README.md) - The `bj` command, one module per command. Exits 0, 1 on a failed check and 2 on `BadInput`.
  - analysis: [./pipeline/analysis/README.md](./pipeline/analysis/README.md) - The engine behind `bj answer`: reads `question.yaml`, compiles the analyses, runs them in one read-only snapshot and publishes the run under `answers/<slug>/`.

## Verification

- Run: `uv run --project orchestration pytest`. It needs `transformation/target/manifest.json` (from `bj install` or `dbt parse`) and the pnpm packages.
