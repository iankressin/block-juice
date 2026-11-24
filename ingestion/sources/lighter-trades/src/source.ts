import { readJson, systemClock, type Source, type Clock } from "@ingestion/lib";
import { createLighterClient, lighterEnv } from "@ingestion/lib/lighter";
import { dayCallSchema, lighterDaysEnv, loadDays, type DayCall } from "@ingestion/lib/lighter/s3";
import * as z from "zod";

// zod refuses .extend on a refined schema. .safeExtend keeps lighterDaysEnv's END_DATE check.
export const tradesEnv = lighterDaysEnv.safeExtend(lighterEnv.shape);

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

// Each UTC day is one file of 2 to 8 million trades, so the source keeps only the trades of the accounts
// and markets in addresses.json. The filter is part of the manifest's key, so a changed addresses.json
// loads every day again. loadDays says which days a run loads.
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
    yield* loadDays(env, retry, context, { dataset: "trades", keyParts: [accounts, markets], where, rowId, clock });
  },
});

export const lighterTrades = tradesSource();
