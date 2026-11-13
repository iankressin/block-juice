import { DAY_MS, historyKey, historyPlan, historyState, retryPages, uniqueBy, type Source } from "@ingestion/lib";
import * as z from "zod";
import { createGammaClient, systemClock, type Clock } from "#src/gamma.ts";
import { callId, marketsWalkCallSchema, openWalkCalls, closedWalkCalls, walkMarkets, type MarketsWalkCall } from "#src/markets.ts";

const gammaEnv = z.object({
  // Polymarket's Gamma API, which needs no key.
  HISTORY_OVERLAP_DAYS: z.coerce.number().int().nonnegative().optional(),
  HISTORY_REFRESH_DAYS: z.coerce.number().int().positive().optional(),
  HISTORY_FULL_REFRESH: z.enum(["0", "1"]).optional(),
  GAMMA_API_URL: z.url().default("https://gamma-api.polymarket.com"),
  GAMMA_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(100),
  // A round sends one request per active walk and starts at most once a second, so at most this many
  // requests a second, under Gamma's 300 per 10 seconds.
  GAMMA_MAX_CONCURRENCY: z.coerce.number().int().positive().max(20).default(6),
  GAMMA_END_DATE_FROM: z.iso
    .date({
      error: (issue) =>
        issue.input === undefined ? "Required" : "Expected an ISO date, such as 2026-10-01",
    })
    .transform((value) => Date.parse(value)),
});

export type GammaEnv = z.infer<typeof gammaEnv>;

// Backfill historical closed days, then revisit recent days and periodic corrections. Open
// and future-closed markets are refreshed every run for both protocols, alongside failed walks.
export const marketsSource = (clock: Clock = systemClock): Source<GammaEnv, MarketsWalkCall> => ({
  name: "polymarket",
  table: "markets",
  env: gammaEnv,
  call: marketsWalkCallSchema,
  async *extract(env, retry, context) {
    const gamma = createGammaClient(env.GAMMA_API_URL, clock);
    const now = clock.now();
    const origin = Math.floor(env.GAMMA_END_DATE_FROM / DAY_MS) * DAY_MS;
    const versions = ["v1", "v2"] as const;
    const plans = new Map<MarketsWalkCall["version"], ReturnType<typeof historyPlan>>();
    for (const version of versions) {
      const key = historyKey(["gamma", env.GAMMA_API_URL, version, origin]);
      const saved = historyState(await context?.getCheckpoint?.(key));
      plans.set(version, historyPlan(key, origin, DAY_MS, now, saved, env));
    }
    const lastStarted = new Map<MarketsWalkCall["version"], number>();
    const isFreshDay = (call: MarketsWalkCall) => call.closed && call.end_date_max !== null
      && Date.parse(call.end_date_min!) >= plans.get(call.version)!.from && Date.parse(call.end_date_min!) <= now;
    async function* calls() {
      yield* openWalkCalls();
      const failedFuture = new Map<MarketsWalkCall["version"], MarketsWalkCall>();
      for await (const page of retryPages(retry, context)) {
        for (const call of uniqueBy(page, callId)) {
          if (!call.closed || isFreshDay(call)) continue;
          if (call.end_date_max !== null) { yield call; continue; }
          const previous = failedFuture.get(call.version);
          if (!previous || call.end_date_min === null
            || previous.end_date_min !== null && Date.parse(call.end_date_min) < Date.parse(previous.end_date_min)) {
            failedFuture.set(call.version, call);
          }
        }
      }
      for (const version of versions) for (const call of closedWalkCalls(version, plans.get(version)!.from, now)) {
        if (call.end_date_max !== null) {
          lastStarted.set(version, Date.parse(call.end_date_min!));
          yield call;
        } else {
          const old = failedFuture.get(version);
          yield old && (old.end_date_min === null || Date.parse(old.end_date_min) < Date.parse(call.end_date_min!))
            ? { ...call, end_date_min: old.end_date_min } : call;
        }
      }
    }
    yield* walkMarkets(gamma, calls(), {
      limit: env.GAMMA_PAGE_SIZE,
      concurrency: env.GAMMA_MAX_CONCURRENCY,
      onProgress: context?.getCheckpoint ? (remaining) => {
        const checkpoints = [];
        for (const version of versions) {
          const last = lastStarted.get(version);
          if (last === undefined) continue;
          const pending = remaining.filter((call) => call.version === version && call.closed && call.end_date_max !== null)
            .map((call) => Date.parse(call.end_date_min!)).filter((date) => date >= plans.get(version)!.from);
          const frontier = Math.min(last + DAY_MS, ...pending);
          checkpoints.push(plans.get(version)!.checkpoint(frontier));
        }
        return checkpoints;
      } : undefined,
    });
  },
});

export const polymarketMarkets = marketsSource();
