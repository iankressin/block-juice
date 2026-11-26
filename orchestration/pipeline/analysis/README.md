# Analysis

The engine behind `bj answer`. It reads `answers/<slug>/question.yaml`, compiles the analyses it names with dbt, checks that each reads only tables it declares, runs them all against one read-only warehouse snapshot, and publishes the answer as a run that never changes. `pipeline/cli/answer.py` drives it and supplies the hooks it calls; `pipeline/cli/check.py`, `pipeline/cli/report.py` and `pipeline/cli/question.py` use parts of it.

## Interface

- `runner.py:run(api, repo_root, slug, window_key)`: the whole `bj answer` flow, from loading the question to printing the value and checks. `api` is the `pipeline.cli.answer` module, which supplies `write_answer`, `run_dbt_tests`, `coverage_check` and the other hooks.
- `runner.py:apply_freshness_policy`: applies the question's `freshness` settings to the freshness check.
- `specification.py:load_question`, `answer_dir`, `Question` (alias `AnalysisSpec`), `SourceInput`, `WindowKey`, and the patterns `SLUG`, `ANALYSIS`, `SOURCE`, `CHAIN`, `FIELDS`: parse and check `question.yaml`. `pipeline/cli/question.py` re-exports them.
- `specification.py:input_filters(question)`: the `filter` of each named input, by name, as the dbt var `inputs`. Hex values go lowercase. It raises `BadInput` for two inputs with one name and for a value that holds `'` or `\`.
- `spec.py:ExecutionPolicy`, `execution_policy`, `parameters`, `typed_value`, `validate_contracts`: typed parameters, column contracts and run limits.
- `scope.py:validate_token_scope`: checks a `parameter_scope: token_windows` question's token against its window and its inputs' filters.
- `compiler.py:QueryCompiler.compile(project, names, blocks, parameters)`: runs `dbt compile` and returns the manifest and the analyses' unique ids.
- `lineage.py:unknown_lineage(manifest, analysis_ids)`: the reasons, sorted, that any analysis reads a table it doesn't declare.
- `executor.py:read_warehouse`: runs every analysis in one snapshot and returns `(Results, dead_letters, last_runs)`.
- `executor.py:latest_ingestion_runs`, `model_builds`, `ingestion_inputs`, `count_dead_letters`: read the run log and the raw schema's bookkeeping tables.
- `executor.py:ancestors`, `relations`: the dependency closure of the analyses and the tables it covers.
- `executor.py:Results`: a list of `Result` that owns the temporary CSVs; `.close()` removes them.
- `provenance.py:run_provenance`, `digest`: the hashes and settings that identify a run.
- `domain.py:Input`, `LastRun`, `Result`, `Check`: frozen dataclasses shared with `pipeline/cli/answer.py`.
- `domain.py:jsonable`, `cell_text`, `headline`: JSON and CSV conversion that keeps every digit, and the answer's single value.
- `store.py:RunStore` (`publish`, `record_edition`), `answer_lock`, `current_run`, `atomic_json`, `file_hashes`, `verify_current_results`: the run store and its lock.

## Invariants

- `question.yaml` rejects unknown top-level keys and needs `question` (`specification.py:_resolve_question`). A slug matches `^[a-z0-9][a-z0-9-]*$` (`specification.py:answer_dir`) and an analysis name `^[A-Za-z0-9_]+$` (`specification.py:_analyses`). `analyses` defaults to `[headline]`. An eval run needs `eval_window`. `expected_columns` and `grain` that name an undeclared analysis raise `BadInput`.
- A window's `blocks` is `[from, to]` with `0 <= from <= to`, or a map from chain to such a range (`specification.py:_window_blocks`). An input's `source` matches `<name>.<table>`, and `all_wallets` must be false when `filter.wallets` is set.
- Parameters must be declared, typed and not named `window`, `coverage` or `inputs` (`spec.py:parameters`, `spec.py:typed_value`). A parameter with no default is required unless its schema sets `required: false`. `values` sets parameters, and an eval run lays `eval_values` over them (`specification.py:_resolve_question`).
- `spec.py:ExecutionPolicy` defaults: `statement_timeout_ms` 900000, `lock_timeout_ms` 10000, `fetch_size` 1000, `max_rows` 0 (no limit). `spec.py:execution_policy` rejects unknown keys and caps `fetch_size` at 100000.
- `compiler.py:QueryCompiler.compile` raises `BadInput` when `dbt compile` fails, when a name is not an analysis, or when `dbt_project.yml`, `profiles.yml`, `packages.yml` or `package-lock.yml` changes during the compile.
- Each analysis must declare its dependencies and parse as exactly one query, and every table it reads must be in `executor.py:relations` (`lineage.py:unknown_lineage`). A failure adds a failed `lineage` check.
- `executor.py:read_warehouse` reads in one read-only REPEATABLE READ transaction, takes `ACCESS SHARE` locks on every declared table first, and rolls back at the end. It raises `BadInput` when an analysis returns no columns, when columns or a typed column's type don't match `expected_columns`, when a `grain` column is missing or a `grain` key repeats, when the row count passes `max_rows`, or on any `psycopg2.Error`.
- An answer has a value only when its first analysis returns one row with one column (`domain.py:headline`). `domain.py:jsonable` writes integers above 2^53 - 1 as strings so no digit is lost.
- `runner.py:apply_freshness_policy` fails a source whose last run is older than `freshness.max_age_hours`. With `require_model_build`, every built ancestor model (not a view or ephemeral) needs a successful build that started after its latest input loaded and after each built model upstream of it finished.
- A window with `scope: loaded` claims nothing about completeness. Its coverage check (`answer.py:loaded_check`) lists each stream input's recorded loads and fails when a load was narrowed or none is recorded, unless the input sets `allow_narrowed` (`runner.py:run`). `runner.py:run` returns 0 only when every check passed, else 1.
- `store.py:RunStore.publish` runs under an exclusive `answer_lock`. A run id is 32 lowercase hex characters and is never reused. `latest.json` moves only after the run is in place.
- `store.py:verify_current_results` returns without a check when the folder has no `latest.json`. Otherwise it raises `BadInput` unless the answer's files match the current run's `answer.json` and the hashes in `artifacts.json`.

## Side Effects

- `compiler.py:QueryCompiler.compile` runs `dbt compile --select <names>` with the window and the `inputs` filters as `vars`, in a temporary folder.
- `executor.py:read_warehouse` locks and reads every table the analyses declare, reads the snapshot id and Postgres catalogs, and spools each analysis to a temporary CSV and a SQLite grain file.
- `executor.py:latest_ingestion_runs` reads `ops.ingestion_runs`. `executor.py:model_builds` reads `ops.dbt_node_runs` and `ops.dbt_node_versions`. `executor.py:count_dead_letters` reads `<RAW_SCHEMA>._dead_letters` and `executor.py:ingestion_inputs` reads `<RAW_SCHEMA>._ingestion_inputs`, each only when the table exists.
- Env vars: `RAW_SCHEMA` (`executor.py`), and `WAREHOUSE_DB`, `RAW_SCHEMA`, `DBT_SCHEMA`, which `provenance.py:run_provenance` records.
- `runner.py:run` writes `answers/<slug>/` (or `answers/<slug>/eval/` for `--eval`) through `api.write_answer`: `answer.json` and `results/<analysis>.csv` among them.
- `store.py:RunStore.publish` copies the run to `answers/<slug>/runs/<run_id>/` with `artifacts.json`, moves the old outputs to `previous/` through `pipeline.answer_artifacts.publish`, then writes `latest.json` atomically.
- `store.py:RunStore.record_edition` copies `answer.json`, `answer.md` and `reports/` to `answers/<slug>/editions/<run_id>/<uuid>/`.
- `store.py:answer_lock` creates the answer folder and `.answer.lock`.

## Verification

- Run: `uv run --project orchestration pytest orchestration/tests/test_analysis_runtime.py orchestration/tests/test_answer_execution.py orchestration/tests/test_model_versions.py orchestration/tests/test_cli_answer.py orchestration/tests/test_cli_question.py`
- All tests: `uv run --project orchestration pytest`
- Question files: `uv run --project orchestration bj questions --check`
