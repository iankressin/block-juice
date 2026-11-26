# CLI

The `bj` command. `__init__.py` holds the argparse tree, `main` and `BadInput`, and each command lives in its own module, imported only when it runs. `pyproject.toml` maps both `bj` and `blockjuice` to `pipeline.cli:main`.

## Interface

Commands (`__init__.py:parser`), each calling `run` in its module:

| Command | Arguments | Module |
| --- | --- | --- |
| `questions` | `[slug] [--json \| --check]` | `catalog.py` |
| `answer` | `<slug> [--eval]` | `answer.py`, which hands off to `pipeline.analysis.runner.run` |
| `check` | `<slug> <name> passed\|failed <detail...> [--eval]` | `check.py` |
| `report` | `<slug> [--format xlsx,pdf\|docx\|gdoc]` (default `xlsx,pdf`) | `report.py`, and `gdoc.py` for `gdoc` |
| `blocks` | `<chain> <from> [<to>] [--rpc URL]` | `blocks.py` |
| `coverage` | `[<source>.<table>]` | `coverage.py` |
| `run` | `<pipeline> [--select KEY ...]` | `run.py` |
| `new-source` | `<source> <table> --like <package>` | `new_source.py` |
| `install` | none | `install.py` |
| `doctor` | `[--copy-env]` | `doctor.py` |
| `dev` | none | `dev.py` |
| `demo` | `[--output PATH]` | `pipeline/demo.py` |

Shared symbols:

- `__init__.py:BadInput`: bad input or config. `main` prints it as one line and exits 2. `pipeline/sources.py`, `pipeline/demo.py` and `pipeline/analysis/` raise it too.
- `__init__.py:require_env`: raises `BadInput` naming each unset key of `REQUIRED_ENV` (`WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER`, `WAREHOUSE_PASSWORD`, `WAREHOUSE_DB`, `RAW_SCHEMA`).
- `__init__.py:utc_iso`: a datetime as ISO 8601 UTC ending in `Z`. A naive datetime counts as UTC.
- `answer.py`: the hooks `pipeline.analysis.runner.run` calls as `api.<name>`: `load_question`, `require_env`, `upstream_inputs`, `stream_inputs`, `compile_analyses`, `coverage` (`sources`, `stream_sources`, `read`), `upstream_tests`, `stale_tests`, `dagster_history`, `run_dbt_tests`, `read_warehouse`, `dead_letters_check`, `freshness_check`, `coverage_check`, `loaded_check`, `provenance`, `answer_document`, `write_answer`. `run_dbt_tests` calls `dbt_tests_check` itself. `answer.py:question_paths` sets `BJ_ANALYSES` and `BJ_MACROS` to one answer's folders, as paths from the dbt project, around a dbt call and restores them after, also after an error. `answer.py:dbt` and `answer.py:dbt_error` run dbt in process and are reused by `run.py:parse_project` (which `install.py` calls) and `pipeline/demo.py`.
- `coverage.py:Coverage`, `read`, `sources`, `stream_sources`: a stream source's coverage, used by `bj coverage` and by `bj answer`'s coverage check.
- `report.py:Report`, `write_docx`: used by `gdoc.py:publish`. `report.py:run` is also called by `pipeline/demo.py`.
- `doctor.py:check_envs`, `port_open`, `COMPOSE_PORTS`, `DAGSTER_PORT`, `FAIL`: reused by `install.py` and `dev.py`. `install.py:setup` and `run_command` are reused by `dev.py`. `run.py:parse_project` is reused by `install.py`.
- `run.py:job_def(module, name)`: rebuilds a job by name in each Dagster step process.
- `question.py`: re-exports `load_question`, `answer_dir`, `Question` and the name patterns from `pipeline/analysis/specification.py`.

## Invariants

- Exit codes: 0 on success, 1 when a check the command ran failed, 2 on `BadInput` (`__init__.py:main`).
- Before any command but `demo`, `main` loads the root `.env` without overriding the shell, and sets `DAGSTER_HOME` to `orchestration/.dagster_home` when unset (`__init__.py:main`).
- Messages name a bad setting by its key, never its value: a bad `START_BLOCK` message names the key and the file it came from (`coverage.py:parse_start_block`), and `gdoc.py` names `GOOGLE_OAUTH_CLIENT_SECRET` or `GOOGLE_APPLICATION_CREDENTIALS` without the path it holds or the error google-auth gives for a bad key. `doctor.py:check_warehouse` and `coverage.py:read` print only the exception type of a failed warehouse read, since the driver's message names the host, user and database.
- Every dbt test run passes `--exclude tag:reference` (`answer.py:run_dbt_tests`). It selects `1+<analysis>`, `+<analysis>,tag:coverage` and each upstream test that hasn't passed since its mart was built (`answer.py:stale_tests`).
- `answer.py:stream_inputs` raises `BadInput` when an input names no source in `sources.json`, when an analysis reads a stream source the question doesn't declare, or when stream inputs have no window blocks and `window.scope` is not `loaded`.
- `bj answer` checks: `dbt_tests` fails on any `fail` or `error`; `dead_letters` needs 0 pending and 0 parked for each input; `freshness` needs a successful last run for each input; `coverage` fails on any gap or on a chain missing from `window.blocks`; with `window.scope: loaded` it lists each input's recorded loads and fails when one was narrowed, none is recorded, or blocks were loaded before coverage was recorded, unless the input sets `allow_narrowed` (`answer.py:*_check`).
- `answer.py:write_answer` stages files in a temporary folder and publishes them through `pipeline.analysis.store.RunStore`. It carries `reports/*.gdoc.json` over to the new answer.
- `check.py:run`: a name matches `^[a-z][a-z0-9_]*$` and is none of `dbt_tests`, `dead_letters`, `freshness`, `coverage`, `lineage`. A check with the same name replaces the old one. Returns 0 for `passed` and 1 for `failed`.
- `catalog.py:run`: `--check` takes no slug, also checks each question's `eval_window` (`check_eval=True`), and returns 1 when an answer holds an analysis its `question.yaml` does not name, or when a `.sql` file remains under `transformation/analyses/`. A duplicate analysis file name inside one answer or a question naming a missing analysis raises `BadInput` (`catalog.py:analysis_paths`, `catalog.py:catalog`).
- `blocks.py:CHAINS` lists the EVM chains `bj blocks` supports. It makes at most `ATTEMPTS` (5) Portal requests, so up to 4 retries, on `BUSY` statuses (429, 503, 529), and each request times out after 30 s. `<to>` must come after `<from>`; without it the window ends now.
- `coverage.py:run` accepts only stream sources, which are those whose `.env.example` sets `START_BLOCK`. `coverage.py:start_block` reads `START_BLOCK` from the shell, then `.env`, then `.env.example`, and an empty value fails rather than falling back. `coverage.py:parse_start_block` accepts the values the Node source accepts, an integer from 0 to 2^53 - 1.
- A source's coverage contract decides whether a missing `wallets` key in `addresses.json` means every wallet: `wallets` under `unrestricted` in `ingestion/sources.json` (`Coverage.unrestricted`).
- `run.py:materialize` raises `BadInput` for an unknown pipeline (the names come from `pipeline.schedules.jobs`, which includes `daily`), and `run.py:selected_keys` for a `--select` key not in the job. It returns 1 when the run fails and prints each failed step's root cause.
- `new_source.py:plan` checks everything before it writes a file: names match `^[a-z][a-z0-9_]*$`, `--like` is a package in `sources.json`, and the new package, staging model and sources entry don't exist yet. `new_source.py:run` then writes every file, and returns 1 when `pnpm install` or `pnpm generate-sources` fails, leaving the files in place.
- `install.py:run_command` raises `BadInput` when the program is not on PATH. `install.py:setup` returns 1 when an env check fails or `pnpm install --frozen-lockfile` fails.
- `doctor.py:run` returns 1 on any FAIL; WARN does not fail. Port and health checks time out after `doctor.py:TIMEOUT` (3 s). A health reply of 502 or 503 counts as starting (WARN).
- `dev.py:run` raises `BadInput` when the Dagster port is in use, and returns 1 when `docker compose up -d` or a doctor check fails.
- `report.py:ROWS_SHOWN` (50) caps the rows per table in PDF and DOCX. `report.py:cell_value` keeps a number as text unless a float holds it exactly, so wei amounts keep every digit. Text cells never become spreadsheet formulas (`report.py:append_row`).
- `report.py:run` holds an exclusive answer lock and checks the results against the current run (`pipeline.analysis.store.verify_current_results`).
- `gdoc.py:SCOPES` asks only for `drive.file`. `gdoc.py:connect` raises `BadInput` when neither `GOOGLE_OAUTH_CLIENT_SECRET` nor `GOOGLE_APPLICATION_CREDENTIALS` is set.

## Side Effects

- `answer.py`: runs `dbt compile` and `dbt test` in process, `git rev-parse HEAD` and `git status --porcelain`, reads the Dagster instance's materialization and check history, reads the warehouse through `pipeline.analysis.executor`, and writes `answers/<slug>/` (`answer.json`, `results/`) or `answers/<slug>/eval/`.
- `check.py:run`: rewrites `answer.json` (or `eval/answer.json`) under the answer lock and records an edition.
- `report.py:run`: writes `answers/<slug>/reports/<slug>.xlsx`, `.pdf` or `.docx` and records an edition under `editions/`.
- `gdoc.py:publish`: calls the Google Drive API to create or update a Google Doc, writes `reports/<slug>.gdoc.json`, and keeps an OAuth token in `~/.config/blockjuice/google-token.json`. Reads `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_DRIVE_FOLDER_ID`.
- `blocks.py`: calls SQD Portal, or the JSON-RPC endpoint given with `--rpc`, and prints the block range as JSON.
- `coverage.py:read`: reads `<RAW_SCHEMA>._sync`, `_coverage` and `_source_configurations` through `pipeline/warehouse.py`, plus each source's `.env`, `.env.example` and `addresses.json`. Reads `START_BLOCK`, `PORTAL_URL`, `POOLS_START_BLOCK` and `SOURCE_BACKFILL_ID`.
- `catalog.py`: reads `answers/*/analyses/**/*.sql` and `answers/*/question.yaml`, and lists `transformation/analyses/**/*.sql` to flag leftovers. No warehouse.
- `run.py:materialize`: runs a Dagster job in process on the `DAGSTER_HOME` instance with the multiprocess executor, which runs sources and dbt.
- `new_source.py:run`: copies `ingestion/sources/<like>/` to a new package (one chain folder for a multi-chain package), renames it in `package.json` and `src/source.ts`, writes `_<source>__sources.yml` and `stg_<source>__<table>.sql` in `transformation/models/staging/<source>/`, then runs `pnpm install` and `pnpm --silent generate-sources`.
- `install.py:setup`: copies each missing `.env` from its `.env.example`, runs `pnpm install --frozen-lockfile` in `ingestion/` and `dbt parse`, which writes `transformation/target/manifest.json`.
- `doctor.py:run`: reads the `.env` files and `mise.toml`, opens TCP connections to the compose ports, connects to the warehouse, calls the eRPC and Dshackle health endpoints, and runs `node`, `pnpm` and `uv --version`. With `--copy-env` it copies missing package `.env` files.
- `dev.py:run`: runs `install`, `docker compose up -d` and the doctor checks, then replaces itself with `dagster dev`.

## Verification

- Run: `uv run --project orchestration pytest orchestration/tests/test_cli_answer.py orchestration/tests/test_cli_blocks.py orchestration/tests/test_cli_catalog.py orchestration/tests/test_cli_check.py orchestration/tests/test_cli_coverage.py orchestration/tests/test_cli_dev.py orchestration/tests/test_cli_doctor.py orchestration/tests/test_cli_install.py orchestration/tests/test_cli_new_source.py orchestration/tests/test_cli_question.py orchestration/tests/test_cli_report.py orchestration/tests/test_cli_run.py`
- All tests: `uv run --project orchestration pytest`
- `uv run --project orchestration bj questions --check`
