import { systemClock, type Source, type Clock } from "@ingestion/lib";
import { dayCallSchema, lighterDaysEnv, loadDays, type DayCall, type LighterDaysEnv } from "@ingestion/lib/lighter/s3";

const rowId = (row: Record<string, unknown>) => `${row.symbol}:${row.hour}`;

// Each day's file holds one row per symbol and hour. loadDays says which days a run loads.
export const openInterestSource = (clock: Clock = systemClock): Source<LighterDaysEnv, DayCall> => ({
  name: "lighter",
  table: "open_interest",
  env: lighterDaysEnv,
  call: dayCallSchema,
  async *extract(env, retry, context) {
    yield* loadDays(env, retry, context, { dataset: "open_interest_hourly", rowId, clock });
  },
});

export const lighterOpenInterest = openInterestSource();
