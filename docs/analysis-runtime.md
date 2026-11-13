# Analysis contracts and saved runs

`bj answer <slug>` still reads `answers/<slug>/question.yaml`, compiles the named dbt analyses, and writes `answer.json` and complete CSVs at the existing paths. `bj report` and `bj check` keep their existing commands. Evaluation runs remain under `answers/<slug>/eval/`.

The authored contract is parsed in `pipeline.analysis.specification`. Compilation, warehouse execution, provenance, orchestration and persistence live in separate modules in `pipeline.analysis`; the CLI retains compatibility exports. Rendering and Google publication remain separate services in `pipeline.cli.report` and `pipeline.cli.gdoc`. Models belong in dbt's model graph; authored queries reference that graph and never own ingestion progress or model builds.

## Optional contracts

Existing manifests require no migration. New manifests can declare:

```yaml
parameters:
  minimum_amount:
    type: integer
    default: 10
values:
  minimum_amount: 20
expected_columns:
  my_analysis:
    - {name: wallet, type: text}
    - {name: amount, type: numeric}
grain:
  my_analysis: [wallet]
execution:
  statement_timeout_ms: 900000
  lock_timeout_ms: 10000
  fetch_size: 1000
  max_rows: 0
freshness:
  max_age_hours: 24
  require_model_build: true
```

Parameters become dbt variables, alongside the existing `window` variable. The names `window` and `coverage` are reserved. Values must be declared, and missing required values fail before compilation. Types are `string`, `integer`, `number`, `boolean`, `date`, `array` and `object`. Arrays declare `items` as a type name or a nested schema; objects declare `properties` as schemas. Object properties can set `required: true` or a default; unknown properties fail. Boolean values do not count as integers. Defaults preserve direct dbt use and the existing project variables.

`expected_columns` requires the exact ordered columns, using strings when only names matter or `{name, type}` for PostgreSQL base types (`int8` or `bigint`, for example). `grain` requires unique tuples of the named columns, including repeated null tuples; the uniqueness index is stored on disk. Schema, grain or row-limit failures leave the previous answer intact.

Timeouts are milliseconds; zero disables a timeout. The default statement timeout is 15 minutes and lock timeout 10 seconds. `max_rows: 0` permits a complete export. Rows are fetched in batches and spooled to CSV; only the first two rows per result remain in Python memory. A nonzero row cap fails the run rather than truncating the answer. PostgreSQL may still need server memory or temporary disk for a query's sort or aggregation, and large exports need local disk space.

Without a freshness policy, the existing successful-load check remains, explicitly labelled as having no age/build requirement. An age policy checks each input's latest successful load. A required build policy checks that each recorded table/incremental model build started after its own input loads completed; views and ephemeral models are read live. Builds run directly outside the application's run recorder have unknown build provenance and cannot satisfy this requirement.

Use `ref()` and `source()` in analyses. A physical relation absent from the manifest's dependency graph makes lineage fail, including when mixed with a declared reference. Native SQL can declare dependencies through dbt's `-- depends_on: {{ ref('model') }}` or `source()` hints. Unqualified physical tables cannot be certified because their meaning depends on `search_path`. A parser cannot certify reads hidden inside user-defined database functions; such dependencies must also be declared.

A historical stream answer still requires the requested block window and filters. An exploratory analysis of the currently loaded subset may explicitly set `window: {scope: loaded}` and declare its sources. Its coverage check states that historical completeness is not asserted; this scope must not be interpreted as complete-chain coverage.

## Snapshot and provenance boundaries

All result queries, ingestion run metadata, dead-letter counts and recorded model-build metadata use one read-only PostgreSQL `REPEATABLE READ` transaction. Declared relations are pinned with `ACCESS SHARE` locks during reads; inserts and updates can continue, while destructive relation replacement waits. Lock and statement timeouts release the transaction on failure. Different analyses in an answer therefore see the same row snapshot.

Coverage observations and dbt tests run **before** this transaction on their own connections. Their observation interval is saved explicitly; they are not certified as checks of the exact result snapshot. Concurrent ingestion may change what those checks see. Relation pins prevent replacement during reads but do not turn separately committed dbt model builds into one atomic warehouse generation. The recorded model-build log is evidence, not a claim that PostgreSQL can reconstruct an old model generation after the transaction closes.

New dbt builds also write optional `ops.dbt_node_versions` rows from that invocation's own manifest: compiled SQL, authored SQL, configuration and manifest hashes, plus dbt's source checksum. The answer joins this evidence to each recorded build invocation; it does not substitute analysis-time code for the code that built a table. Legacy builds, an old ops schema, or unavailable evidence are explicitly `unknown`. The additive table is created by the existing idempotent `infra/postgres/ops.sql` bootstrap. A missing table, missing artifact or optional evidence-write failure never rolls back the original run log or changes the pipeline result.

For an existing local stack, apply the additive ops schema from the repository root with `docker compose run --rm warehouse-init`. This project's separate init service also runs on normal stack startup; it does not depend on a new Postgres volume. For an external warehouse, connect with the normal PostgreSQL client settings and run `psql -v ON_ERROR_STOP=1 -f infra/postgres/ops.sql`. Both commands preserve warehouse rows. The next recorded build adds version evidence; historical rows remain unknown because their original build artifacts cannot be inferred.

The answer records its run ID, the exact question bytes read, effective typed parameters, compiled SQL hashes, the actual compiled manifest and dependency graph hashes, authored SQL from the compiled manifest, project-file hashes captured across compilation, coverage observations, database/schema names and the snapshot/build observations. Passwords and environment secrets are not saved. Compilation refuses a project configuration change detected between its start and end. Saved CSVs are the durable result; an MVCC snapshot identifier is not a permanent time-travel backup.

## Immutable history and compatible authoring

Each successful publication creates `runs/<run_id>/` containing the exact authored `question.yaml`, effective `spec.json`, compiled `manifest.json`, and immutable execution artifacts and an `artifacts.json` SHA-256 inventory. `latest.json` is replaced atomically after the compatible root files are prepared. Publication, checks and report generation use one per-answer file lock, preventing concurrent CLI writers from mixing generations. An ordinary publication error restores the prior root files and pointer. A process or machine crash may leave an unpublished candidate directory; only the run named by `latest.json` is current.

The existing root `answer.md` remains the authoring location. Refreshing an answer clears its old narrative and reports, retains Google document identity, and keeps the previous projection under `previous/`. All execution runs survive subsequent refreshes. `bj check` and `bj report` create separate append-only editions under `editions/<run_id>/`; they never rewrite the original execution snapshot. Reports verify that result metadata and CSV hashes match the current run before rendering. Hand-written old narratives cannot be judged automatically; the author remains responsible for what the narrative says.

Legacy saved answers without `latest.json` remain readable. The application does not automatically delete run history. Remove old run/edition directories only when they are no longer needed, keeping the run referenced by `latest.json` and any artifacts needed for audit or reproduction. The lock coordinates local processes; use a filesystem that supports the platform's normal file locks and atomic renames.
