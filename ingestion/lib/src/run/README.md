# Run

## Overview

`runSource`, the entry point of every source, and the Pushgateway gauges each run sends. It runs a call source or a stream source once, loads what it yields through [the warehouse](../warehouse/README.md), and records the outcome in the run log and the metrics. Part of [`@ingestion/lib`](../../README.md).

## Interface

- `runSource(source, warehouse = postgresWarehouse())` (`index.ts`): runs one `Source` or `StreamSource` inside `withTransportMetrics`. Exported from `@ingestion/lib`.
- `RunReport` (`index.ts`): `runId`, `dagsterRunId`, `source`, `table`, `startedAt`, `finishedAt`, `error` (undefined on success), `retriedCalls`, `recordsWritten`, `failedCalls`, `loadSeconds`, `backlog` (undefined when the run failed before it counted its dead letters).
- `runMetrics(report)` and `pushRunMetrics(report, log)` (`metrics.ts`): the end-of-run gauges:
  - `ingestion_last_run_timestamp_seconds`, `ingestion_last_run_success`, `ingestion_last_run_duration_seconds`
  - `ingestion_last_run_retried_calls`, `ingestion_last_run_records_written`, `ingestion_last_run_failed_calls`
  - `ingestion_last_success_timestamp_seconds`, sent only when the run succeeded
  - `ingestion_dead_letters{state="pending"|"parked"}`, sent only when the run has a backlog
- `RunProgress`, `progressMetrics(progress)` and `pushProgressMetrics(progress, log)` (`metrics.ts`): the `ingestion_current_*` gauges for the run in progress, such as `active`, `records_written`, `batches_committed`, `committed_block` (-1 before any commit), `memory_rss_bytes` and the transport counts (`requests_started`, `queue_wait_seconds`, `delay_seconds` and the rest).
- Settings, read with `loadEnv` (`index.ts:runEnv`, `metrics.ts:metricsEnv`):
  - `DAGSTER_RUN_ID`: optional; set when Dagster started the run.
  - `MAX_BLOCKS_PER_RUN`: optional; a positive whole number of at most 15 digits. Unset or empty means no cap.
  - `SOURCE_BACKFILL_ID`: optional; matches `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`.
  - `PUSHGATEWAY_URL`: optional URL. Unset means the run pushes no metrics.
  - The source's own `env` schema.

## Invariants

- `runSource` never throws. Any error, an invalid environment included, logs once as fatal (`Run failed`) and sets `process.exitCode = 1`.
- A failed call only warns. The records that arrived stay written, and the call waits as a dead letter.
- Call source: the retries are the source table's pending dead letters that still parse with `source.call`. With `retryMode: "paged"`, `extract` gets the first page as `retry` and the rest as `context.retryPages`. Without it, `extract` gets every retry in one array (`table.retries`). A dead letter that no longer parses is parked, and the run logs a warning.
- Each call-source batch loads in one transaction (`table.load`). `callsCompleted` is `batch.callsCompleted`, or else the count of distinct record `callId`s, failed ids and `succeededCallIds`.
- Stream source: `source.stream(env)` pipes into `table.pipesTarget`. The block cap is `MAX_BLOCKS_PER_RUN` when set, else `source.maxBlocksPerRun`, else none. Coverage is recorded only when `streamProvenance` returns a contract, and then the cursor id comes from `table.configureStream`.
- `captureJsonReads` wraps the whole run, so each `readJson` call goes into the input evidence. Only a stream source keeps the parsed values, which coverage needs; a call source keeps file hashes and sizes.
- Progress pushes start every 15 s only after `warehouse.open` returns, so a run that waits for another run's source lock never replaces that run's gauges. At most one push is in flight. The last progress push finishes before `table.close()` releases the lock.
- Metrics pushes never throw and time out after 5000 ms. `pushAdd` replaces only the gauges it sends, so a failed run keeps the time of the last success and a run without a backlog keeps the last dead-letter count.

## Side Effects

- Opens the raw table `<name>_<table>` through `warehouse.open`, which creates tables and holds a source lock until `close` (see [the warehouse](../warehouse/README.md)).
- Writes records, dead letters, checkpoints, coverage and input evidence through the table handle.
- Adds one row to `ops.ingestion_runs` per run (`warehouse.recordRun`), success or failure.
- Pushes gauges to `PUSHGATEWAY_URL` with `jobName: "ingestion"`, grouped by `source` and `table`.
- Logs through `logger.child({ source, table })`: `Run started`, `Batch committed`, `Run finished`, `Run failed`, and warnings for failed and parked calls.
- Sets `process.exitCode` when the run fails.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/lib test`
- Run: `pnpm -C ingestion typecheck`
