import { uniqueBy, type Source } from "@ingestion/lib";
import * as z from "zod";
import { createGammaClient, systemClock, type Clock } from "#src/gamma.ts";
import { callId, marketsWalkCallSchema, walkCalls, walkMarkets, type MarketsWalkCall } from "#src/markets.ts";

const gammaEnv = z.object({
  // Polymarket's Gamma API, which needs no key.
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

// Every market Gamma lists, as it sends it: the open ones, the closed ones of each end date since
// GAMMA_END_DATE_FROM, and the closed ones that end after today, for both protocol versions. Plus
// the walks that failed in earlier runs.
export const marketsSource = (clock: Clock = systemClock): Source<GammaEnv, MarketsWalkCall> => ({
  name: "polymarket",
  table: "markets",
  env: gammaEnv,
  call: marketsWalkCallSchema,
  async *extract(env, retry) {
    const gamma = createGammaClient(env.GAMMA_API_URL, clock);
    const calls = walkCalls(env.GAMMA_END_DATE_FROM, clock.now());
    // A new call comes after its retried twin, so it is the one kept.
    yield* walkMarkets(gamma, uniqueBy([...retry, ...calls], callId), {
      limit: env.GAMMA_PAGE_SIZE,
      concurrency: env.GAMMA_MAX_CONCURRENCY,
    });
  },
});

export const polymarketMarkets = marketsSource();
