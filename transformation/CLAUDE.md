# Transformation

The dbt project. Run dbt with the command in the root `CLAUDE.md`, which exports `.env` first. Raw tables live in `RAW_SCHEMA` (`raw`) and models build in `DBT_SCHEMA` (`analytics`).

## Layers

- Staging, in `models/staging/<name>/`: one view per raw table and kind of record, named `stg_<name>__<table>`, where `<name>` is the source's name (the chain for `evm-*` sources). A raw table that holds logs and transactions gets `stg_<name>__<table>` and `stg_<name>__<table>_transactions`. Cast fields out of `data` and lowercase EVM addresses. Keep Solana and Bitcoin addresses as they are, since base58 is case-sensitive. No joins and no rules.
- Intermediate, in `models/intermediate/<pipeline>/`: joins and rules, one model per protocol version, named `int_<chain>_<protocol>_<version>_<thing>`. Give each rule a dbt unit test built from a real log in the protocol's `catalog/protocols/<name>/NOTES.md`.
- Marts, in `models/marts/<pipeline>/`: facts that many questions reuse, with `unique` and `not_null` tests on the grain. A mart over several versions or chains unions their intermediate models, with a column that names each row's version or chain. Reconciliation tests that compare rebuilt values with state readings go in `tests/`.
- YAML sits beside the models: `_<name>__sources.yml` and `_<name>__models.yml` in staging, `_int_<pipeline>__models.yml` in intermediate (`balances/` has one per chain), `_<pipeline>__models.yml` in marts.

## Materialization

- Staging builds views and marts build tables. Intermediate models default to ephemeral; most pipeline folders override that with `+materialized: view` in `dbt_project.yml`, so each model shows as its own step in Dagster. Do the same for a new folder.
- Keep staging and intermediate models live. Never make a model incremental with a `max(block_number)` or `max(_loaded_at)` filter: late rows and corrections would never reach the marts (`docs/fact-model-performance.md`).
- Filters and joins on jsonb staging columns get Postgres's default row estimates, and the planner picks nested loops that go quadratic on real data. The polymarket and deployments folders set `set local enable_nestloop = off` as a pre-hook in `dbt_project.yml` for this reason. When a model like that builds slowly, check its plan for nested loops first.

## Pipelines, tokens and analyses

- A new pipeline is a `models/marts/<pipeline>/` folder plus an entry in `PIPELINES` in `orchestration/pipeline/schedules.py`. pytest fails when an asset belongs to no scheduled pipeline.
- Join tokens on `(chain, token)`, never on `symbol`: tokens share symbols, and one token has a different address on each chain. A null `decimals` means the contract doesn't say; never assume 18.
- Each `analyses/*.sql` reads marts through `ref()`, takes its window from `in_window()` in `macros/window.sql`, and belongs to exactly one `answers/<slug>/question.yaml`. Outside `bj answer`, an analysis compiles but fails when run, with `no window for <chain>`. To run one by hand, pass `--vars '{window: {ethereum: [<first block>, <last block>]}}'`. `docs/analysis-authoring.md` covers writing one without the skill.
- `seeds/reference/` and `tests/reference/` hold the factory's reference rows and tests, tagged `reference`. Dagster and `bj answer` leave them out; run them with `dbt test --select tag:reference`.
