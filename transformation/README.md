# Transformation

dbt models that read each source's raw table and build the marts consultants query.

Ethereum hex addresses are lowercased in staging. Solana and Bitcoin addresses are kept as-is because they are case-sensitive (base58).

## Subdirectories & Boundaries

- models: [./models/README.md](./models/README.md) - The three layers: [staging](./models/staging/README.md), [intermediate](./models/intermediate/README.md) and [marts](./models/marts/README.md).
- macros: [./macros/README.md](./macros/README.md) - The analysis window (`in_window`), token scope, shared flow aggregations, the test helpers `erc20_balance_pairs` and `reference_mismatches`, `fact_config` with the `reconcile` strategy for fact marts, and `index_state_readings` for raw-table indexes.
- analyses: [./analyses/README.md](./analyses/README.md) - One SQL file per query a question runs, grouped by the `answers/<slug>/question.yaml` that names it.
- benchmarks: [./benchmarks/README.md](./benchmarks/README.md) - `facts.py` and `state_models.py`, run by hand against a throwaway database or temporary relations.
- `seeds/` (CSV seeds, with `seeds/reference/` for the factory's reference rows) and `tests/` (singular and reference tests) hold no models of their own.

## Invariants

- Raw tables live in `RAW_SCHEMA` (`raw`); every model builds in `DBT_SCHEMA` (`analytics`). dbt reads both from the environment, and falls back to those defaults when they are unset: `DBT_SCHEMA` in `profiles.yml`, `RAW_SCHEMA` in each staging `_<name>__sources.yml`. The `WAREHOUSE_*` settings have no defaults.
- Staging builds views and marts build tables (`dbt_project.yml`). Intermediate models are ephemeral unless their folder sets `+materialized: view`.
- Tests tagged `reference` stay out of Dagster and `bj answer` builds; run them with `dbt test --select tag:reference`.

## Verification

- `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- After touching an analysis or a `question.yaml`: `uv run --project orchestration bj questions --check`.
- With a warehouse up: `uv run --project orchestration bj run <pipeline> --select <model>`, which also runs the model's tests.
- After adding or changing a model: `uv run --project orchestration python transformation/planted_bugs.py --changed-since origin/main`, which fails when no unit test catches a bug planted in it. CI runs it on every pull request ([docs/planted-bugs.md](../docs/planted-bugs.md)).

## Adding a chain

`bj new-source` already scaffolds the dbt sources YAML and a staging model that selects `id`, `data` and `_loaded_at` from that source, then regenerates `ingestion/sources.json`, which Dagster builds its `SOURCES` from. See `orchestration/pipeline/cli/new_source.py`. It does not add the chain to a mart, and it schedules nothing: `PIPELINES` in `orchestration/pipeline/schedules.py` stays a hand step.

The remaining steps, by hand:

1. Add `int_<chain>_balances.sql` and its contract YAML, copied from an existing chain in `models/intermediate/balances/`. The contract names any missing or mistyped column at build time.
2. Add a `union all` branch for that model in `models/marts/balances/latest_balances.sql`.
3. Add the chain to the `accepted_values` of `chain` in `models/marts/balances/_balances__models.yml`.
