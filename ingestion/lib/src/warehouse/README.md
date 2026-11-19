# Warehouse

## Overview

Every write ingestion makes to Postgres: each source's raw table, the dead letters, call-source checkpoints, stream coverage, input evidence and the run log. A stream source loads through Pipes' Postgres target, which keeps its cursor in `_sync`. Sources reach this code only through [`runSource`](../run/README.md). Part of [`@ingestion/lib`](../../README.md).

## Interface

- `postgresWarehouse(settings?)` / `Warehouse` (`index.ts`): `{ open(sourceTable), recordRun(report, log) }`.
- `open(sourceTable)` returns the table handle:
  - `name`, `deadLetters`: quoted table names.
  - `load(batch)`: writes one `Batch` and returns `{ seconds, writeSeconds, commitSeconds }`.
  - `retryPages(call, size = 500)`: pages of pending dead letters, each `{ calls, parked }`. `retries(call)` collects every page into one.
  - `getCheckpoint(key)`: the stored checkpoint value, or undefined.
  - `configureStream(provenance)`, `pipesTarget(options)`: the stream path.
  - `trackInputs(runId, read)`, `finishInputs()`: input evidence.
  - `backlog()`: `DeadLetterBacklog`, `{ pending, parked }`.
  - `close()`: ends the session and its locks.
- `recordRun(report, log)`: inserts one row into `ops.ingestion_runs`.
- Types (`index.ts`): `DeadLetterBacklog`, `Connection` (`query`, `drizzle`, `close`), `Query`, `WarehouseSettings` (`schema`, `connect`).
- `pipesTarget(...)` / `PipesTargetOptions` (`stream.ts`): `maxBlocks`, `provenance`, `cursorId`, `onLoad({ records, seconds, writeSeconds, committedBlock })`.
- `StreamProvenance`, `fingerprint`, `streamProvenance`, `prepareProvenance`, `configureStream`, `recordCoverage` (`provenance.ts`).
- `inputEvidence`, `InputEvidence`, `prepareInputEvidence`, `recordInputEvidence` (`input-evidence.ts`).
- `pgliteWarehouse(t)` (`pglite.fixture.ts`): for tests. A warehouse in an in-process PGlite with schema `raw`, loaded with `infra/postgres/ops.sql`.
- Settings, read on every `open` and `recordRun` and not at import, unless `settings` is passed: `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER`, `WAREHOUSE_PASSWORD`, `WAREHOUSE_DB`, `RAW_SCHEMA`.
- Tables in `RAW_SCHEMA`, each created `if not exists`:

| Table | Key | Other columns |
| --- | --- | --- |
| `<name>_<table>` | `id` | `data` (jsonb), `_loaded_at` |
| `_dead_letters` | `(source_table, id)` | `call`, `error`, `attempts`, `parked`, `first_failed_at`, `last_failed_at`; partial index `_dead_letters_retry_page` |
| `_checkpoints` | `(source_table, key)` | `value` (jsonb), `updated_at` |
| `_coverage` | `(source_table, fingerprint, from_block)` | `to_block`, `config`, `verified`, `updated_at` |
| `_source_configurations` | `(source_table, fingerprint)` | `cursor_id`, `config`, `created_at` |
| `_ingestion_inputs` | `(run_id, source_table)` | `config_hash`, `evidence`, `updated_at` |
| `_sync` | Pipes' cursor id | Pipes creates and owns it |

## Invariants

- The schema and table names must match `^[a-z_][a-z0-9_]*$`, or `open` throws `Invalid SQL identifier`.
- Only one run of a source table at a time. `open` takes one session `pg_advisory_lock(hashtext('ingestion.source'), hashtext('"<schema>"."<table>"'))` before the DDL and holds it until `close`, through call extraction and every batch. The `create ... if not exists` statements run under `pg_advisory_xact_lock(hashtext('ingestion'), hashtext('warehouse.ddl'))`, so sources that Dagster opens at once take turns. Both keys have two parts, which Postgres keeps apart from the one-part keys Pipes locks its cursors with.
- `load` writes a batch's records, cleared dead letters, new failures, checkpoints and input evidence in one transaction, and rolls back on error.
- Records upsert at most `CHUNK_SIZE` (500) per statement, keeping the last record per `id` in a batch. Unchanged `data` keeps the stored jsonb value; `_loaded_at` always moves to `now()`.
- Bigints go into jsonb as strings (`toJson`), since jsonb numbers lose precision past 2^53.
- A record's `callId`, or an id in `succeededCallIds`, deletes the dead letter with that id.
- A failed call starts at `attempts = 1` or adds one. It is parked when attempts reach `MAX_ATTEMPTS` (5).
- `retryPages` reads through a `with hold` cursor, ordered by `first_failed_at, id`, so it sees the backlog as it stood before extraction. Page size is 1 to 5000. A dead letter that no longer parses with `call` is parked, with the schema mismatch as its error, unless its call changed since the read.
- Stream: Pipes wraps each batch in one transaction, and the records, the coverage and the `_sync` cursor commit together. The target sets `requiresFinalizedStream: true` and tracks no tables for rollback. `onLoad` runs only after the commit. With `maxBlocks`, the run stops on the batch that passes the cap.
- `streamProvenance` returns a contract only when the source declares `coverage` and its env has a numeric `START_BLOCK` and a string `PORTAL_URL`. It reads filters only from files whose path ends in `addresses.json`, lowercases values unless the key is in `coverage.caseSensitive`, and throws when a filter key holds anything but strings. `SOURCE_BACKFILL_ID` becomes `backfill`, and a numeric `POOLS_START_BLOCK` makes it version 2.
- `configureStream` binds a raw table to one dataset: it throws when the `datasetHash` (SHA-256 of `PORTAL_URL`) differs from a recorded one. The same fingerprint reuses its cursor id. The first configuration without a backfill keeps the source table as its cursor id; any later one, or a backfill, gets `<source_table>_<first 24 hex of the fingerprint>`.
- `recordCoverage` extends an interval that ends one block before the new one with the same `verified`, or inserts a new one. When `POOLS_START_BLOCK` is set, an interval is verified only if a fresh cursor started at or before it, or it extends a verified interval.
- `inputEvidence` leaves out keys that match `KEY|SECRET|PASSWORD|AUTH|CREDENTIAL|PRIVATE|TOKEN` and lists them in `redacted_keys`. A `*_URL` value becomes its origin and a SHA-256. Numbers, booleans, `BLOCK_NUMBER`, `CANDLE_INTERVAL`, `GAMMA_END_DATE_FROM` and `SOURCE_BACKFILL_ID` stay as written. Any other value becomes a SHA-256.
- Input evidence is optional. A failed write rolls back to a savepoint, warns, and stops further evidence writes for the run; it does not fail the data transaction.
- `recordRun` opens its own connection, so a run whose connection broke still records that it failed. It never throws; a failure only warns.

## Side Effects

- Opens a Postgres connection per `open` and per `recordRun` (`pg.Client`, or the `connect` in `settings`).
- Creates the raw schema and the tables above when they are missing.
- Inserts, updates and deletes rows in those tables, and inserts into `ops.ingestion_runs`, which `infra/postgres/ops.sql` creates.
- Takes session and transaction advisory locks, and declares and closes `with hold` cursors named `retry_page_<n>`.
- Logs warnings through `logger` and the passed `log`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/lib test`
- Run: `pnpm -C ingestion typecheck`
