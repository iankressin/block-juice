import { randomUUID } from "node:crypto";
import * as z from "zod";
import { describeError } from "#src/calls.ts";
import { loadEnv } from "#src/env.ts";
import { logger } from "#src/logger.ts";
import { pushProgressMetrics, pushRunMetrics, type RunProgress } from "#src/run/metrics.ts";
import type { Source, StreamSource } from "#src/source.ts";
import { postgresWarehouse, type DeadLetterBacklog, type Warehouse } from "#src/warehouse/index.ts";

// A positive whole number of blocks, at most 15 digits, so it stays a safe integer.
// Zero, a negative, a decimal or other text fails the run instead of meaning no cap.
// Unset or empty means no cap: loadEnv treats an empty value as unset.
const blockCount = z
  .string()
  .regex(
    /^[1-9]\d{0,14}$/,
    "Expected a positive whole number of blocks. Leave it unset for no cap.",
  )
  .transform(Number);

const runEnv = z.object({
  DAGSTER_RUN_ID: z.string().min(1).optional(),
  MAX_BLOCKS_PER_RUN: blockCount.optional(),
});

/** What runSource reports when a run ends, to the Pushgateway and to ops.ingestion_runs. */
export type RunReport = {
  runId: string;
  /** Set when Dagster started the run. */
  dagsterRunId: string | undefined;
  source: string;
  table: string;
  startedAt: Date;
  finishedAt: Date;
  /** Undefined when the run succeeded. */
  error: string | undefined;
  retriedCalls: number;
  recordsWritten: number;
  failedCalls: number;
  /** Time spent writing records and dead letters to the warehouse. The rest went to extraction. */
  loadSeconds: number;
  /** Undefined when the run failed before it counted its dead letters. */
  backlog: DeadLetterBacklog | undefined;
};

/**
 * The entry point of every source. A call source has its dead letters that still parse
 * retried, and each batch it yields loaded. A stream source is piped into the warehouse,
 * where Pipes resumes it after the last block it loaded. Either way, runSource counts what
 * happened. Failed calls only warn; the records that did arrive are kept.
 *
 * Any error, including an invalid environment, is logged once as fatal and sets the exit
 * code, instead of reaching Node's own crash output. Every run pushes its metrics and adds
 * a row to the warehouse's run log.
 */
export async function runSource<E, C>(
  source: Source<E, C> | StreamSource<E>,
  warehouse: Warehouse = postgresWarehouse(),
): Promise<void> {
  const runId = randomUUID();
  const log = logger.child({ source: source.name, table: source.table });
  const startedAt = new Date();
  let retriedCalls = 0;
  let recordsWritten = 0;
  let failedCalls = 0;
  let loadSeconds = 0;
  let backlog: DeadLetterBacklog | undefined;
  let error: string | undefined;
  let dagsterRunId: string | undefined;
  let writeSeconds = 0;
  let commitSeconds = 0;
  let batchesCommitted = 0;
  let callsCompleted = 0;
  let committedBlock: number | undefined;
  let activePush: Promise<void> | undefined;
  const progress = (inProgress: boolean): RunProgress => ({
    source: source.name, table: source.table, startedAt, inProgress,
    recordsWritten, failedCalls, retriedCalls, callsCompleted, batchesCommitted,
    loadSeconds, writeSeconds, commitSeconds, committedBlock,
  });
  const publish = () => {
    if (!activePush) activePush = pushProgressMetrics(progress(true), log).finally(() => { activePush = undefined; });
    return activePush;
  };
  const progressTimer = setInterval(() => { void publish(); }, 15_000);
  progressTimer.unref();


  try {
    // Inside the try so a bad MAX_BLOCKS_PER_RUN fails the run with one fatal log, like any other
    // invalid environment, instead of reaching Node's own crash output.
    const { DAGSTER_RUN_ID, MAX_BLOCKS_PER_RUN } = loadEnv(runEnv);
    dagsterRunId = DAGSTER_RUN_ID;
    const env = loadEnv(source.env);
    const table = await warehouse.open(`${source.name}_${source.table}`);
    try {
      if ("stream" in source) {
        log.info({ runId }, "Run started");
        const stream = await source.stream(env);
        await stream.pipeTo(
          table.pipesTarget({
            // The env var wins when it is set. Otherwise the source's own cap, or no cap at all.
            maxBlocks: MAX_BLOCKS_PER_RUN ?? source.maxBlocksPerRun,
            onLoad({ records, seconds, writeSeconds: executed, committedBlock: block }) {
              loadSeconds += seconds;
              writeSeconds += executed;
              recordsWritten += records;
              batchesCommitted++;
              committedBlock = block;
              log.info({ target: table.name, records, committedBlock, loadSeconds: seconds,
                writeSeconds: executed, transactionOverheadSeconds: seconds - executed,
                rssBytes: process.memoryUsage().rss }, "Batch committed");
            },
          }),
        );
      } else {
        // Existing custom extract(env, retry) implementations receive the same complete
        // array as before. Built-ins explicitly opt into consuming every bounded page.
        const pages = source.retryMode === "paged" ? table.retryPages(source.call)
          : (async function* () { yield await table.retries(source.call); })();
        const notePage = (page: { calls: C[]; parked: number }) => {
          retriedCalls += page.calls.length;
          if (page.parked > 0) log.warn(
            { parked: page.parked, deadLetters: table.deadLetters },
            "Some dead letters no longer match the source's call schema and wait for a person",
          );
          return page.calls;
        };
        const first = await pages.next();
        const retry = first.done ? [] : notePage(first.value);
        async function* remaining() {
          for await (const page of pages) yield notePage(page);
        }
        log.info({ runId, retriedCalls }, "Run started");

        for await (const batch of source.extract(env, retry, { retryPages: remaining(), getCheckpoint: table.getCheckpoint })) {
          const timing = await table.load(batch);
          loadSeconds += timing.seconds;
          writeSeconds += timing.writeSeconds;
          commitSeconds += timing.commitSeconds;
          batchesCommitted++;
          callsCompleted += new Set([...batch.records.map((record) => record.callId),
            ...batch.failed.map((failed) => failed.id), ...(batch.succeededCallIds ?? [])]).size;
          recordsWritten += batch.records.length;
          failedCalls += batch.failed.length;
          log.info(
            {
              target: table.name,
              records: batch.records.length,
              failedCalls: batch.failed.length,
              ...timing,
              rssBytes: process.memoryUsage().rss,
            },
            "Batch committed",
          );
        }
      }

      backlog = await table.backlog();
      log.info({ recordsWritten, failedCalls, backlog }, "Run finished");
      if (failedCalls > 0) {
        log.warn(
          { failedCalls, deadLetters: table.deadLetters },
          "Some calls failed and wait as dead letters for the next run",
        );
      }
    } finally {
      await table.close();
    }
  } catch (err) {
    log.fatal({ err }, "Run failed");
    error = describeError(err);
    process.exitCode = 1;
  } finally {
    clearInterval(progressTimer);
    await activePush;
    await pushProgressMetrics(progress(false), log);
  }

  const report: RunReport = {
    runId,
    dagsterRunId,
    source: source.name,
    table: source.table,
    startedAt,
    finishedAt: new Date(),
    error,
    retriedCalls,
    recordsWritten,
    failedCalls,
    loadSeconds,
    backlog,
  };
  await Promise.all([pushRunMetrics(report, log), warehouse.recordRun(report, log)]);
}
