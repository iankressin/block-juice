import { describeError, type Batch, type RawRecord } from "@ingestion/lib";
import * as z from "zod";
import type { GammaClient, Market } from "#src/gamma.ts";

const version = z.enum(["v1", "v2"]);

/**
 * One walk of one filter set, from its first page to its last. Gamma sends `version` v1 markets
 * unless asked, so a run walks both versions. `end_date_min` and `end_date_max` are null when the
 * walk has no bound on that side.
 */
export const marketsWalkCallSchema = z.object({
  kind: z.literal("markets_walk"),
  version,
  closed: z.boolean(),
  end_date_min: z.iso.datetime().nullable(),
  end_date_max: z.iso.datetime().nullable(),
});

export type MarketsWalkCall = z.infer<typeof marketsWalkCallSchema>;

// Gamma takes a time as 2026-11-07T00:00:00Z.
const utc = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export function callId(call: MarketsWalkCall): string {
  if (!call.closed) return `markets:${call.version}:open`;
  if (call.end_date_max === null) return `markets:${call.version}:closed:after`;
  return `markets:${call.version}:closed:${call.end_date_min!.slice(0, 10)}`;
}

const DAY_MS = 86_400_000;

/**
 * Per version: the open markets, with no date filter so one without an end date is kept; the
 * closed markets of each UTC end date from `from` to the day of `now`; and the closed markets that
 * end after today, which exist.
 */
export function walkCalls(from: number, now: number): MarketsWalkCall[] {
  const start = Math.floor(from / DAY_MS) * DAY_MS;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const calls: MarketsWalkCall[] = [];
  for (const v of version.options) {
    calls.push({ kind: "markets_walk", version: v, closed: false, end_date_min: null, end_date_max: null });
    for (let t = start; t <= today; t += DAY_MS) {
      calls.push({
        kind: "markets_walk",
        version: v,
        closed: true,
        end_date_min: utc(t),
        end_date_max: utc(t + DAY_MS),
      });
    }
    calls.push({
      kind: "markets_walk",
      version: v,
      closed: true,
      end_date_min: utc(today + DAY_MS),
      end_date_max: null,
    });
  }
  return calls;
}

type Walk = { call: MarketsWalkCall; cursor: string | undefined; page: number };

/**
 * Walks every call to its last page, `concurrency` walks at once. A round fetches the next page of
 * each active walk together and yields one batch: its records, a market that two walks met once,
 * and the walks that failed in it. A walk ends on a page with no cursor, or with no markets, and its
 * slot goes to the next pending walk. A walk whose page fails after the client's retries stops
 * there: the pages it yielded stay, and its call waits as a dead letter, because a market is
 * written by id and so a walk again is safe.
 */
export async function* walkMarkets(
  gamma: GammaClient,
  calls: readonly MarketsWalkCall[],
  { limit, concurrency }: { limit: number; concurrency: number },
): AsyncGenerator<Batch<MarketsWalkCall>> {
  const pending = calls.map((call): Walk => ({ call, cursor: undefined, page: 0 }));
  let active: Walk[] = [];
  while (pending.length > 0 || active.length > 0) {
    while (active.length < concurrency && pending.length > 0) active.push(pending.shift()!);
    const outcomes = await Promise.allSettled(
      active.map((walk) =>
        gamma.markets({
          version: walk.call.version,
          closed: walk.call.closed,
          endDateMin: walk.call.end_date_min,
          endDateMax: walk.call.end_date_max,
          limit,
          afterCursor: walk.cursor,
        }),
      ),
    );
    const records = new Map<string, RawRecord>();
    const succeededCallIds: string[] = [];
    const batch: Batch<MarketsWalkCall> = { records: [], failed: [], succeededCallIds };
    const next: Walk[] = [];
    active.forEach((walk, i) => {
      const outcome = outcomes[i]!;
      const id = callId(walk.call);
      if (outcome.status === "rejected") {
        batch.failed.push({ id, call: walk.call, error: describeError(outcome.reason) });
        return;
      }
      const { markets, nextCursor } = outcome.value;
      const last = nextCursor === undefined || markets.length === 0;
      // Only the last page's records carry the walk's id. The lib clears a dead letter when a record
      // carries its id, so an earlier page would clear the letter of a walk that fails later.
      const recordCallId = last ? id : `${id}#${walk.page}`;
      for (const market of markets) records.set(`market:${market.id}`, record(market, recordCallId));
      if (last) succeededCallIds.push(id);
      else next.push({ call: walk.call, cursor: nextCursor, page: walk.page + 1 });
    });
    batch.records.push(...records.values());
    active = next;
    yield batch;
  }
}

const record = (market: Market, callId: string): RawRecord => ({
  id: `market:${market.id}`,
  callId,
  data: market,
});
