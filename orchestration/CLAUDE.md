# Orchestration

This folder's contract (interface, invariants and side effects) is in [README.md](README.md), and each folder under `pipeline/` has its own.

Dagster definitions and the `bj` CLI, in Python. Run everything through `uv run --project orchestration` from the repo root.

## The CLI

- Each command is a module in `pipeline/cli/` that returns its exit code: 0, or 1 when a check it ran failed. Bad input or config raises `BadInput` (`pipeline/cli/__init__.py`), which `main` prints as one line and turns into exit 2.
- `bj` loads the root `.env` before it runs a command, without overriding the shell. Dagster and dbt do not load it.
- A command names a bad setting by its key, never its value. It never prints a raw driver error either, since a Postgres connection error can name the host, port, user and database.
- dbt's default eager indirect selection runs every test that reads a selected node, even one that also reads unselected nodes. Selecting a mart, with or without `+`, also runs each reference test that reads it, so every dbt build or test in `pipeline/` passes `--exclude tag:reference`.

## Tests

- Tests are plain functions in `tests/`, named as sentences, such as `test_every_asset_and_check_runs_in_a_scheduled_pipeline`. They fake the outside world: `tests/fake_portal.py` serves Portal from memory, `tests/stub_pipelines.py` holds the stub jobs the `bj run` tests start, and most tests fake pnpm, docker and dbt. No test reaches the network.
- `conftest.py` points `DAGSTER_HOME` at a temporary folder, so test runs stay out of the checkout's Dagster history.
- Tests that need Postgres use the `scratch` fixture from `test_warehouse.py`. They run only when `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER` and `WAREHOUSE_PASSWORD` are set, and then create and drop a `bj_test_*` database on that server. With `CI` set, a failed connection fails them instead of skipping them.

These tests tie the layers together, so a change in `ingestion/` or `transformation/` can fail them:

- `test_sources_json.py`: `ingestion/sources.json` matches what `pnpm generate-sources` writes (the test runs pnpm), and each entry has its table in `_<name>__sources.yml` and its `stg_<name>__<table>.sql` in `transformation/models/staging/<name>/`.
- `test_definitions.py`: each ingestion asset feeds its staging model and has a `no_dead_letters` check, and every asset and check runs in a scheduled pipeline. The balances, dex and transfers marts must read each chain or protocol version through its own intermediate model.
- `test_cli_catalog.py`: every analysis sits in its answer's `analyses/` folder and is named by its `question.yaml`, and the shipped questions' contracts cover each query.
