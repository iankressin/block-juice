import { describeError, historyKey, uniqueBy, systemClock, type Source, type Clock } from "@ingestion/lib";
import {
  dayBatches,
  dayCallSchema,
  dayManifest,
  lighterS3Env,
  listDays,
  type DayCall,
  type DayFile,
} from "@ingestion/lib/lighter/s3";
import * as z from "zod";

const DATASET = "open_interest_hourly";
const DAY_MS = 86_400_000;

export const openInterestEnv = lighterS3Env
  .extend({ START_DATE: z.iso.date(), END_DATE: z.iso.date().optional() })
  .refine((env) => !env.END_DATE || env.END_DATE >= env.START_DATE, {
    path: ["END_DATE"],
    message: "END_DATE may not come before START_DATE",
  });

export type OpenInterestEnv = z.infer<typeof openInterestEnv>;

const rowId = (row: Record<string, unknown>) => `${row.symbol}:${row.hour}`;

// Lighter writes one file a day, about 07:03 UTC the next day. Each run lists the days from START_DATE
// to END_DATE, or to yesterday in UTC, and loads those whose ETag the manifest does not hold, oldest
// first and one at a time. A day that fails waits as a dead letter and the next day still loads. The
// manifest records a failed day too, so a retry reads the date's current file, unless the run loads
// that date anyway. A retry whose file has gone fails again. Once the framework parks a dead letter
// (five failed runs), the manifest still lists the day, so it reloads only when its ETag changes.
export const openInterestSource = (clock: Clock = systemClock): Source<OpenInterestEnv, DayCall> => ({
  name: "lighter",
  table: "open_interest",
  env: openInterestEnv,
  call: dayCallSchema,
  async *extract(env, retry, context) {
    const to = env.END_DATE ?? new Date(clock.now() - DAY_MS).toISOString().slice(0, 10);
    const key = historyKey(["lighter", env.LIGHTER_S3_URL, env.LIGHTER_S3_PREFIX, DATASET]);
    const days = await listDays(env, DATASET, env.START_DATE, to, clock);
    const manifest = dayManifest(key, await context?.getCheckpoint?.(key), days);

    const pending = new Set(manifest.pending.map((day) => day.date));
    const retried = uniqueBy(retry, (call) => call.date).filter((call) => !pending.has(call.date));
    const work: { date: string; day?: DayFile; call?: DayCall }[] = [
      ...manifest.pending.map((day) => ({ date: day.date, day })),
      ...retried.map((call) => ({ date: call.date, call })),
    ].sort((a, b) => a.date.localeCompare(b.date));

    for (const item of work) {
      let day: DayFile | undefined;
      try {
        day = item.day ?? (await listDays(env, DATASET, item.date, item.date, clock))[0];
      } catch (error) {
        // A failed listing of one retried date is a failed call, not a failed run.
        yield { records: [], failed: [{ id: `${DATASET}:${item.date}`, call: item.call!, error: describeError(error) }], callsCompleted: 1 };
        continue;
      }
      if (!day) {
        yield {
          records: [],
          failed: [{ id: `${DATASET}:${item.date}`, call: item.call!, error: `Lighter S3 has no ${DATASET} file for ${item.date}` }],
          callsCompleted: 1,
        };
        continue;
      }
      yield* dayBatches(env, day, { rowId, checkpoint: manifest.loaded(day), clock });
    }
  },
});

export const lighterOpenInterest = openInterestSource();
