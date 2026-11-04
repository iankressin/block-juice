# Checks

`bj answer` runs these checks and writes each one to `answer.json` as `passed` or `failed`, with a detail. It exits 1 when any check fails.

| Check | Fails when | What to do |
|---|---|---|
| `dbt_tests` | A dbt test on a model upstream of the analyses fails or errors. | Read the failing test's SQL in `transformation/target/compiled/`. Fix the model or the source, rebuild, rerun `bj answer`. |
| `dead_letters` | An input's raw table has pending or parked dead letters, so some calls never produced records and the answer may miss data. | Pending ones retry on the next run: run the pipeline again. Parked ones failed too often or no longer match the source's call schema: read their `error` in `raw._dead_letters` and tell the user. |
| `freshness` | An input has no successful run in `ops.ingestion_runs`. | Run the pipeline. If the run fails, read its `error` in `ops.ingestion_runs` and fix that first. |

The detail of `freshness` lists when each input last loaded. Read it even when the check passes: an answer about "now" built on data from last week says so in `answer.md`.

History answers will add two checks, `coverage` (no gap in the block ranges loaded over the window) and `cross_check` (one number matches an independent query). Both come with history backfills.
