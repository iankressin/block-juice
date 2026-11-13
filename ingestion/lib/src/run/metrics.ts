import { Gauge, Pushgateway, Registry } from "@prometheus-io/client";
import * as z from "zod";
import { loadEnv } from "#src/env.ts";
import type { Logger } from "#src/logger.ts";
import type { RunReport } from "#src/run/index.ts";
import type { TransportMetrics } from "#src/transport-metrics.ts";

/**
 * A source runs as a short job, so Prometheus cannot scrape it. Each run pushes these
 * gauges to the Pushgateway instead, grouped by source and table. A failed run leaves out
 * `ingestion_last_success_timestamp_seconds`, and `pushAdd` replaces only the metrics it
 * sends, so the Pushgateway keeps the time of the last success. A run without a backlog
 * leaves out `ingestion_dead_letters` the same way, so the last count stays.
 */
export function runMetrics(report: RunReport): Registry {
  const registry = new Registry();
  const gauge = (name: string, help: string, value: number) =>
    new Gauge({ name, help, registers: [registry] }).set(value);
  const finishedAt = report.finishedAt.getTime() / 1000;
  const succeeded = report.error === undefined;

  gauge("ingestion_last_run_timestamp_seconds", "When the last run finished, successful or not.", finishedAt);
  gauge("ingestion_last_run_success", "1 if the last run succeeded, 0 if it failed.", succeeded ? 1 : 0);
  gauge(
    "ingestion_last_run_duration_seconds",
    "How long the last run took.",
    (report.finishedAt.getTime() - report.startedAt.getTime()) / 1000,
  );
  gauge("ingestion_last_run_retried_calls", "Dead letters from earlier runs that the last run retried.", report.retriedCalls);
  gauge("ingestion_last_run_records_written", "Records the last run wrote to the raw table.", report.recordsWritten);
  gauge("ingestion_last_run_failed_calls", "Calls that failed in the last run and wait as dead letters.", report.failedCalls);
  if (succeeded) {
    gauge("ingestion_last_success_timestamp_seconds", "When the last successful run finished.", finishedAt);
  }
  if (report.backlog) {
    const deadLetters = new Gauge({
      name: "ingestion_dead_letters",
      help: "Dead letters waiting after the last run. Pending ones are retried next run, parked ones wait for a person.",
      labelNames: ["state"],
      registers: [registry],
    });
    deadLetters.set({ state: "pending" }, report.backlog.pending);
    deadLetters.set({ state: "parked" }, report.backlog.parked);
  }
  return registry;
}

const metricsEnv = z.object({ PUSHGATEWAY_URL: z.url().optional() });

/** Never throws: a run that wrote its records stays successful when its metrics cannot be sent. */
export async function pushRunMetrics(report: RunReport, log: Logger): Promise<void> {
  try {
    const { PUSHGATEWAY_URL } = loadEnv(metricsEnv);
    if (!PUSHGATEWAY_URL) {
      log.info("PUSHGATEWAY_URL is not set, so this run pushes no metrics");
      return;
    }
    const gateway = new Pushgateway(PUSHGATEWAY_URL, { timeout: 5000 }, runMetrics(report));
    await gateway.pushAdd({
      jobName: "ingestion",
      groupings: { source: report.source, table: report.table },
    });
  } catch (error) {
    log.warn({ err: error }, "Could not push metrics");
  }
}


export type RunProgress = {
  source: string; table: string; startedAt: Date; finishedAt?: Date; inProgress: boolean;
  recordsWritten: number; failedCalls: number; retriedCalls: number; callsCompleted: number;
  batchesCommitted: number; loadSeconds: number; writeSeconds: number; commitSeconds: number;
  committedBlock?: number;
  transport?: TransportMetrics;
};

/** Separate current-run gauges never overwrite the previous completed run's success. */
export function progressMetrics(progress: RunProgress): Registry {
  const registry = new Registry();
  const values: [string, string, number][] = [
    ["active", "1 while a run is active, 0 after it ends.", progress.inProgress ? 1 : 0],
    ["timestamp_seconds", "When progress was last reported.", Date.now() / 1000],
    ["elapsed_seconds", "Elapsed wall time of the current run.", ((progress.finishedAt?.getTime() ?? Date.now()) - progress.startedAt.getTime()) / 1000],
    ["records_written", "Records in committed batches of the current run.", progress.recordsWritten],
    ["failed_calls", "Failed calls saved in committed batches.", progress.failedCalls],
    ["retried_calls", "Previously failed calls supplied to the source.", progress.retriedCalls],
    ["calls_completed", "Distinct call outcomes across committed batches, including failed calls.", progress.callsCompleted],
    ["batches_committed", "Batches whose transactions have committed.", progress.batchesCommitted],
    ["load_seconds", "Warehouse transaction time including locks, retries and commit.", progress.loadSeconds],
    ["write_seconds", "Time executing raw-data and retry statements in committed batches.", progress.writeSeconds],
    ["commit_seconds", "Time awaiting explicit COMMIT for call sources; stream commit is included in load_seconds.", progress.commitSeconds],
    ["memory_rss_bytes", "Current process resident memory in bytes.", process.memoryUsage().rss],
  ];
  const transport = progress.transport;
  if (transport) values.push(
    ["requests_started", "Transport attempts started in this run, including retries.", transport.requestsStarted],
    ["requests_completed", "Transport attempts completed, including failures.", transport.requestsCompleted],
    ["requests_failed", "Transport exceptions and HTTP error responses; excludes application-level errors.", transport.requestsFailed],
    ["requests_active", "Transport attempts currently awaiting a response.", transport.activeRequests],
    ["request_seconds", "Sum of transport attempt durations; fetch measures through response headers.", transport.requestSeconds],
    ["queue_tasks", "Tasks currently waiting for a client concurrency slot.", transport.queuedTasks],
    ["queue_wait_seconds", "Sum of completed waits for client concurrency slots.", transport.queueWaitSeconds],
    ["delay_tasks", "Tasks currently in client rate-limit or retry-backoff delays.", transport.delayedTasks],
    ["delay_seconds", "Sum of completed client rate-limit and retry-backoff delay durations.", transport.delaySeconds],
  );
  if (progress.committedBlock !== undefined) values.push(["committed_block", "Last stream block confirmed committed.", progress.committedBlock]);
  for (const [name, help, value] of values) new Gauge({ name: `ingestion_current_${name}`, help, registers: [registry] }).set(value);
  return registry;
}

/** A metrics outage must not fail a pipeline or create overlapping pushes. The runner serializes calls. */
export async function pushProgressMetrics(progress: RunProgress, log: Logger): Promise<void> {
  try {
    const { PUSHGATEWAY_URL } = loadEnv(metricsEnv);
    if (!PUSHGATEWAY_URL) return;
    const gateway = new Pushgateway(PUSHGATEWAY_URL, { timeout: 5000 }, progressMetrics(progress));
    await gateway.pushAdd({ jobName: "ingestion", groupings: { source: progress.source, table: progress.table } });
  } catch (err) { log.warn({ err }, "Could not push ingestion progress"); }
}
