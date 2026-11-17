import {
  callBatches,
  describeError,
  historyKey,
  historyPlan,
  historyState,
  readJson,
  type Batch,
  type RawRecord,
  type Source,
} from "@ingestion/lib";
import {
  createLighterClient,
  lighterEnv,
  systemClock,
  type Clock,
  type LighterClient,
  type LighterMarket,
} from "@ingestion/lib/lighter";
import * as z from "zod";

const HOUR_MS = 3_600_000;

// The most entries Lighter sends for one request. A longer range gets the newest 750 and loses the
// oldest with no error, so a window never spans more.
const WINDOW_HOURS = 750;
const WINDOW_MS = WINDOW_HOURS * HOUR_MS;

const startTime = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected an ISO date or datetime, such as 2026-10-01 or 2026-10-01T00:00:00Z",
  })
  .transform((value) => Date.parse(value));

const fundingsEnv = lighterEnv.extend({
  START_TIME: startTime,
  HISTORY_OVERLAP_DAYS: z.coerce.number().int().nonnegative().optional(),
  HISTORY_REFRESH_DAYS: z.coerce.number().int().positive().optional(),
  HISTORY_FULL_REFRESH: z.enum(["0", "1"]).optional(),
});

export type LighterFundingsEnv = z.infer<typeof fundingsEnv>;

const time = z.number().int().nonnegative();

/** One window of up to 750 hourly entries of one market. Times are in ms. */
const fundingCallSchema = z.object({
  market_id: z.number().int().nonnegative(),
  symbol: z.string(),
  start_time: time,
  end_time: time,
});

type FundingCall = z.infer<typeof fundingCallSchema>;

const callId = (call: FundingCall) => `${call.market_id}:${call.start_time}`;

const marketsFile = z.object({
  markets: z.array(z.string().min(1)).min(1, "markets.json lists no markets: add a symbol such as ETH"),
});

function parseMarkets(json: unknown): string[] {
  const parsed = marketsFile.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid markets.json:\n${z.prettifyError(parsed.error)}`);
  return [...new Set(parsed.data.markets)];
}

const hourStart = (at: number) => at - (at % HOUR_MS);

const fundingReply = z.object({ fundings: z.array(z.looseObject({ timestamp: z.number() })) });

/**
 * Reads one window. An entry counts only when its hour mark lies inside the window and its hour
 * closed before the request went out. Lighter sends no entry for the hour still accruing, but the
 * time rule does not lean on that, and a closed hour can pay a zero, so a zero says nothing.
 */
async function fetchWindow(lighter: LighterClient, call: FundingCall, clock: Clock): Promise<RawRecord[]> {
  const cutoff = clock.now();
  const reply = fundingReply.parse(
    await lighter.get("/api/v1/fundings", {
      market_id: call.market_id,
      resolution: "1h",
      start_timestamp: call.start_time,
      end_timestamp: call.end_time,
      count_back: 0,
    }),
  );
  return reply.fundings
    .filter(({ timestamp }) => {
      const paidAt = timestamp * 1000;
      return paidAt >= call.start_time && paidAt <= call.end_time && paidAt + HOUR_MS <= cutoff;
    })
    .map((funding) => ({
      id: `${call.market_id}:${funding.timestamp}`,
      callId: callId(call),
      data: { market_id: call.market_id, symbol: call.symbol, funding },
    }));
}

// Backfill each perp market's hourly funding from START_TIME, then refresh recent windows and
// periodic older ones. A window holds at most 750 hours, and the windows meet with no gap. One
// request runs at a time, because the Lighter client sends one at a time anyway.
export const fundingsSource = (clock: Clock = systemClock): Source<LighterFundingsEnv, FundingCall> => ({
  name: "lighter",
  table: "fundings",
  env: fundingsEnv,
  call: fundingCallSchema,
  retryMode: "paged",
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad markets.json.
    const symbols = parseMarkets(readJson(new URL("../markets.json", import.meta.url)));
    const lighter = createLighterClient(env, clock);
    const markets: LighterMarket[] = await lighter.resolveMarkets(symbols);
    // Lighter answers a spot market's fundings with HTTP 400, code 21619.
    const spot = markets.find((market) => market.market_type !== "perp");
    if (spot) throw new Error(`markets.json lists ${spot.symbol}, a spot market; fundings exist only for perp markets`);

    const now = clock.now();
    const plans = new Map<number, ReturnType<typeof historyPlan>>();
    for (const market of markets) {
      const key = historyKey(["lighter", "fundings", env.LIGHTER_API_URL, market.symbol, env.START_TIME]);
      const saved = historyState(await context?.getCheckpoint?.(key));
      const origin = saved?.origin ?? hourStart(env.START_TIME);
      plans.set(market.market_id, historyPlan(key, origin, WINDOW_MS, now, saved, env));
    }
    function* fresh(): Generator<FundingCall> {
      for (const market of markets) {
        for (let start = plans.get(market.market_id)!.from; start <= now; start += WINDOW_MS) {
          yield { market_id: market.market_id, symbol: market.symbol, start_time: start, end_time: start + WINDOW_MS - 1 };
        }
      }
    }
    const isFresh = (call: FundingCall) => {
      const plan = plans.get(call.market_id);
      return !!plan && call.start_time >= plan.from && call.start_time <= now
        && (call.start_time - plan.from) % WINDOW_MS === 0 && call.end_time === call.start_time + WINDOW_MS - 1;
    };

    for await (const [call] of callBatches(fresh(), retry, callId, isFresh, context, 1, true)) {
      const batch: Batch<FundingCall> = { records: [], failed: [], succeededCallIds: [] };
      try {
        batch.records = await fetchWindow(lighter, call!, clock);
        batch.succeededCallIds!.push(callId(call!));
      } catch (error) {
        batch.failed.push({ id: callId(call!), call: call!, error: describeError(error) });
      }
      if (context?.getCheckpoint && isFresh(call!)) {
        batch.checkpoints = [plans.get(call!.market_id)!.checkpoint(call!.end_time + 1)];
      }
      yield batch;
    }
  },
});

export const lighterFundings = fundingsSource();
