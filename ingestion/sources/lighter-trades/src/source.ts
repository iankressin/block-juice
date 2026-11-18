import { describeError, historyKey, readJson, uniqueBy, systemClock, type Source, type Clock } from "@ingestion/lib";
import { createLighterClient, lighterEnv } from "@ingestion/lib/lighter";
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

const DATASET = "trades";
const DAY_MS = 86_400_000;

export const tradesEnv = lighterEnv
  .extend(lighterS3Env.shape)
  .extend({ START_DATE: z.iso.date(), END_DATE: z.iso.date().optional() })
  .refine((env) => !env.END_DATE || env.END_DATE >= env.START_DATE, {
    path: ["END_DATE"],
    message: "END_DATE may not come before START_DATE",
  });

export type LighterTradesEnv = z.infer<typeof tradesEnv>;

const tooWide =
  "addresses.json lists no accounts and no markets. List at least one: one day of Lighter trades is 2 to 8 million rows.";

// An absent key reads every account or market; a present one must list some. A misspelled key fails
// rather than drop its filter.
const addressesFile = z.strictObject({
  accounts: z
    .array(z.int().nonnegative(), { error: "must be a list of account indexes, such as 313004" })
    .min(1, "lists no accounts. List at least one, or remove the key to read every account.")
    .optional(),
  markets: z
    .array(z.string().min(1), { error: "must be a list of market symbols, such as ETH" })
    .min(1, "lists no markets. List at least one, or remove the key to read every market.")
    .optional(),
});

function parseAddresses(json: unknown) {
  const parsed = addressesFile.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid addresses.json:\n${z.prettifyError(parsed.error)}`);
  if (!parsed.data.accounts && !parsed.data.markets) throw new Error(tooWide);
  return parsed.data;
}

const sortedIds = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b);

/** A SQL list. readDay takes `where` as trusted SQL, so every id must be a whole number from 0 up. */
function sqlList(ids: readonly number[]): string {
  const bad = ids.find((id) => !Number.isSafeInteger(id) || id < 0);
  if (bad !== undefined) throw new Error(`Not an id for a Lighter trade filter: ${bad}`);
  return ids.join(", ");
}

/**
 * The rows to keep. The file's market_id is a slot that Lighter reuses, and public_market_index is
 * the API's market_id, null before 2026-08-20, so a market filters on the public id, never the slot
 * (catalog/vendors/lighter/NOTES.md, Market identity).
 */
function tradeFilter(accounts: readonly number[] | undefined, markets: readonly number[] | undefined): string {
  const parts: string[] = [];
  if (accounts) parts.push(`(ask_account_id in (${sqlList(accounts)}) or bid_account_id in (${sqlList(accounts)}))`);
  if (markets) parts.push(`coalesce(public_market_index, market_id) in (${sqlList(markets)})`);
  return parts.join(" and ");
}

const rowId = (row: Record<string, unknown>) => String(row.id);

// Each UTC day is one file of 2 to 8 million trades, which appears about 07:03 UTC the next day. Each
// run lists the days from START_DATE to END_DATE, or to yesterday in UTC, and loads the trades of the
// accounts and markets in addresses.json from each day whose ETag the manifest does not hold, oldest
// first and one at a time. The filter is part of the manifest's key, so a changed addresses.json
// loads every day again. A day that fails waits as a dead letter and the next day still loads. The
// manifest records a failed day too, so a retry reads the date's current file, unless the run loads
// that date anyway. A retry whose file has gone fails again. Once the framework parks a dead letter
// (five failed runs), the manifest still lists the day, so it reloads only when its ETag changes.
export const tradesSource = (clock: Clock = systemClock): Source<LighterTradesEnv, DayCall> => ({
  name: "lighter",
  table: "trades",
  env: tradesEnv,
  call: dayCallSchema,
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = parseAddresses(readJson(new URL("../addresses.json", import.meta.url)));
    const accounts = addresses.accounts && sortedIds(addresses.accounts);
    const markets =
      addresses.markets &&
      sortedIds((await createLighterClient(env, clock).resolveMarkets(addresses.markets)).map((m) => m.market_id));
    const where = tradeFilter(accounts, markets);

    const to = env.END_DATE ?? new Date(clock.now() - DAY_MS).toISOString().slice(0, 10);
    const key = historyKey(["lighter", env.LIGHTER_S3_URL, env.LIGHTER_S3_PREFIX, DATASET, accounts, markets]);
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
      yield* dayBatches(env, day, { where, rowId, checkpoint: manifest.loaded(day), clock });
    }
  },
});

export const lighterTrades = tradesSource();
