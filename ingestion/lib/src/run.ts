import { randomUUID } from "node:crypto";
import * as z from "zod";
import { describeError } from "#src/calls.ts";
import { postgresDeadLetterQueue } from "#src/dead-letters/postgres.ts";
import { loadEnv } from "#src/env.ts";
import { logger } from "#src/logger.ts";
import { pushRunMetrics } from "#src/metrics.ts";
import { recordRun } from "#src/run-log.ts";
import { postgresTarget } from "#src/targets/postgres.ts";
import type {
  DeadLetter,
  DeadLetterBacklog,
  DeadLetterQueue,
  Source,
  Target,
} from "#src/types.ts";

const runEnv = z.object({ DAGSTER_RUN_ID: z.string().min(1).optional() });

const schemaMismatch = (error: z.ZodError) =>
  `The call no longer matches the source's call schema. ${error.issues
    .map((issue) =>
      issue.path.length
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ")}`;

/**
 * The entry point of every source. Per batch: write the records, clear the dead letters they
 * answer, then queue the new failures. A crash between the first two steps leaves a dead
 * letter whose retry writes its record again. Failed calls only warn; the records that did
 * arrive are kept.
 *
 * Any error, including an invalid environment, is logged once as fatal and sets the exit
 * code, instead of reaching Node's own crash output. Every run pushes its metrics and adds
 * a row to ops.ingestion_runs.
 */
export async function runSource<E, C>(
  source: Source<E, C>,
  target: Target = postgresTarget(),
  deadLetters: DeadLetterQueue = postgresDeadLetterQueue(),
): Promise<void> {
  const runId = randomUUID();
  const { DAGSTER_RUN_ID } = loadEnv(runEnv);
  const log = logger.child({ source: source.name, table: source.table });
  const startedAt = new Date();
  let retriedCalls = 0;
  let recordsWritten = 0;
  let failedCalls = 0;
  let loadSeconds = 0;
  let backlog: DeadLetterBacklog | undefined;
  let error: string | undefined;

  try {
    const env = loadEnv(source.env);
    const name = `${source.name}_${source.table}`;
    const table = await target.open(name);
    try {
      const queue = await deadLetters.open(name);
      try {
        const retry: C[] = [];
        const unparsed: Pick<DeadLetter, "id" | "error">[] = [];
        for (const letter of await queue.pending()) {
          const call = source.call.safeParse(letter.call);
          if (call.success) retry.push(call.data);
          else
            unparsed.push({ id: letter.id, error: schemaMismatch(call.error) });
        }
        if (unparsed.length > 0) {
          await queue.park(unparsed);
          log.warn(
            { parked: unparsed.length, deadLetters: queue.name },
            "Some dead letters no longer match the source's call schema and wait for a person",
          );
        }
        retriedCalls = retry.length;
        log.info({ runId, retriedCalls }, "Run started");

        for await (const batch of source.extract(env, retry)) {
          const loadStartedAt = performance.now();
          await table.write(batch.records);
          await queue.resolve(batch.records.map((r) => r.callId));
          await queue.push(batch.failed);
          loadSeconds += (performance.now() - loadStartedAt) / 1000;
          recordsWritten += batch.records.length;
          failedCalls += batch.failed.length;
          log.info(
            {
              target: table.name,
              records: batch.records.length,
              failedCalls: batch.failed.length,
            },
            "Batch written",
          );
        }

        backlog = await queue.backlog();
        log.info({ recordsWritten, failedCalls, backlog }, "Run finished");
        if (failedCalls > 0) {
          log.warn(
            { failedCalls, deadLetters: queue.name },
            "Some calls failed and wait as dead letters for the next run",
          );
        }
      } finally {
        await queue.close();
      }
    } finally {
      await table.close();
    }
  } catch (err) {
    log.fatal({ err }, "Run failed");
    error = describeError(err);
    process.exitCode = 1;
  }

  const report = {
    runId,
    dagsterRunId: DAGSTER_RUN_ID,
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
  await Promise.all([pushRunMetrics(report, log), recordRun(report, log)]);
}
