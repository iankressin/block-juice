import type { Logger } from "#src/logger.ts";
import { postgresSettings } from "#src/postgres.ts";
import type { RunReport } from "#src/types.ts";

/**
 * Adds the run to ops.ingestion_runs, which infra/postgres/init.sql creates. Never throws:
 * a run that wrote its records stays successful when its log row cannot be written.
 */
export async function recordRun(report: RunReport, log: Logger): Promise<void> {
  try {
    const client = await postgresSettings().connect([]);
    try {
      await client.query(
        `insert into ops.ingestion_runs (
           run_id, dagster_run_id, source, table_name, started_at, finished_at, succeeded,
           records_written, failed_calls, retried_calls, load_seconds,
           dead_letters_pending, dead_letters_parked, error
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          report.runId,
          report.dagsterRunId ?? null,
          report.source,
          report.table,
          report.startedAt,
          report.finishedAt,
          report.error === undefined,
          report.recordsWritten,
          report.failedCalls,
          report.retriedCalls,
          report.loadSeconds,
          report.backlog?.pending ?? null,
          report.backlog?.parked ?? null,
          report.error ?? null,
        ],
      );
    } finally {
      await client.end();
    }
  } catch (error) {
    log.warn({ err: error }, "Could not record the run in ops.ingestion_runs");
  }
}
