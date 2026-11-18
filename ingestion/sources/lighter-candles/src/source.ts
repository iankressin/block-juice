import {
  callBatches,
  describeError,
  historyKey,
  historyPlan,
  historyState,
  readJson,
  systemClock,
  type Batch,
  type RawRecord,
  type Source,
  type Clock,
} from "@ingestion/lib";
import {
  createLighterClient,
  lighterEnv,
  type LighterClient,
  type LighterMarket,
} from "@ingestion/lib/lighter";
import * as z from "zod";

const RESOLUTION_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
} as const;

type Resolution = keyof typeof RESOLUTION_MS;

const resolution = z.enum(Object.keys(RESOLUTION_MS) as [Resolution, ...Resolution[]]);

// The most candles Lighter sends for one request. A longer range gets the newest 500 and loses the
// oldest with no error, so a window never spans more.
const WINDOW_CANDLES = 500;

const startTime = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected an ISO date or datetime, such as 2026-10-01 or 2026-10-01T00:00:00Z",
  })
  .transform((value) => Date.parse(value));

const candlesEnv = lighterEnv.extend({
  CANDLE_RESOLUTION: resolution.default("1h"),
  START_TIME: startTime,
  HISTORY_OVERLAP_DAYS: z.coerce.number().int().nonnegative().optional(),
  HISTORY_REFRESH_DAYS: z.coerce.number().int().positive().optional(),
  HISTORY_FULL_REFRESH: z.enum(["0", "1"]).optional(),
});

export type LighterCandlesEnv = z.infer<typeof candlesEnv>;

const PATHS = { trade: "/api/v1/candles", mark: "/api/v1/markPriceCandles" } as const;

type Price = keyof typeof PATHS;

const prices = Object.keys(PATHS) as Price[];

const time = z.number().int().nonnegative();

/** One window of up to 500 candles of one market and price series. */
const candleCallSchema = z.object({
  market_id: z.number().int().nonnegative(),
  symbol: z.string(),
  price: z.enum(["trade", "mark"]),
  resolution,
  start_time: time,
  end_time: time,
});

type CandleCall = z.infer<typeof candleCallSchema>;

const callId = (call: CandleCall) => `${call.market_id}:${call.price}:${call.resolution}:${call.start_time}`;

const marketsFile = z.object({
  markets: z.array(z.string().min(1)).min(1, "markets.json lists no markets: add a symbol such as ETH"),
});

function parseMarkets(json: unknown): string[] {
  const parsed = marketsFile.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid markets.json:\n${z.prettifyError(parsed.error)}`);
  return [...new Set(parsed.data.markets)];
}

const bucketStart = (at: number, res: Resolution) => at - (at % RESOLUTION_MS[res]);

const windowSpan = (res: Resolution) => WINDOW_CANDLES * RESOLUTION_MS[res];

const candleReply = z.object({ c: z.array(z.looseObject({ t: z.number() })) });

/**
 * Reads one window. A candle counts only when it opened inside the window and closed before the
 * request went out: the still-open bucket still changes, so the next run loads it. Lighter's
 * range ends are not clear about which side they include, so a candle outside is dropped too.
 */
async function fetchWindow(lighter: LighterClient, call: CandleCall, clock: Clock): Promise<RawRecord[]> {
  const span = RESOLUTION_MS[call.resolution];
  const cutoff = clock.now();
  const reply = candleReply.parse(
    await lighter.get(PATHS[call.price], {
      market_id: call.market_id,
      resolution: call.resolution,
      start_timestamp: call.start_time,
      end_timestamp: call.end_time,
      count_back: 0,
    }),
  );
  return reply.c
    .filter(({ t }) => t >= call.start_time && t <= call.end_time && t + span <= cutoff)
    .map((candle) => ({
      id: `${call.market_id}:${call.price}:${call.resolution}:${candle.t}`,
      callId: callId(call),
      data: { market_id: call.market_id, symbol: call.symbol, price: call.price, resolution: call.resolution, candle },
    }));
}

// Backfill each market's trade and mark-price candles from START_TIME, then refresh recent windows
// and periodic older ones. A window holds at most 500 candles, and the windows meet with no gap.
// One request runs at a time, because the Lighter client sends one at a time anyway.
export const candlesSource = (clock: Clock = systemClock): Source<LighterCandlesEnv, CandleCall> => ({
  name: "lighter",
  table: "candles",
  env: candlesEnv,
  call: candleCallSchema,
  retryMode: "paged",
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad markets.json.
    const symbols = parseMarkets(readJson(new URL("../markets.json", import.meta.url)));
    const lighter = createLighterClient(env, clock);
    const markets: LighterMarket[] = await lighter.resolveMarkets(symbols);

    const res = env.CANDLE_RESOLUTION;
    const now = clock.now();
    const span = windowSpan(res);
    const plans = new Map<string, ReturnType<typeof historyPlan>>();
    const planKey = (market_id: number, price: Price) => `${market_id}:${price}`;
    for (const market of markets) {
      for (const price of prices) {
        const key = historyKey(["lighter", env.LIGHTER_API_URL, market.market_id, market.symbol, price, res, env.START_TIME]);
        const saved = historyState(await context?.getCheckpoint?.(key));
        const origin = saved?.origin ?? bucketStart(env.START_TIME, res);
        plans.set(planKey(market.market_id, price), historyPlan(key, origin, span, now, saved, env));
      }
    }
    function* fresh(): Generator<CandleCall> {
      for (const market of markets) {
        for (const price of prices) {
          for (let start = plans.get(planKey(market.market_id, price))!.from; start <= now; start += span) {
            yield {
              market_id: market.market_id,
              symbol: market.symbol,
              price,
              resolution: res,
              start_time: start,
              end_time: start + span - 1,
            };
          }
        }
      }
    }
    const isFresh = (call: CandleCall) => {
      const plan = plans.get(planKey(call.market_id, call.price));
      return !!plan && call.resolution === res && call.start_time >= plan.from && call.start_time <= now
        && (call.start_time - plan.from) % span === 0 && call.end_time === call.start_time + span - 1;
    };

    for await (const [call] of callBatches(fresh(), retry, callId, isFresh, context, 1, true)) {
      const batch: Batch<CandleCall> = { records: [], failed: [], succeededCallIds: [] };
      try {
        batch.records = await fetchWindow(lighter, call!, clock);
        batch.succeededCallIds!.push(callId(call!));
      } catch (error) {
        batch.failed.push({ id: callId(call!), call: call!, error: describeError(error) });
      }
      if (context?.getCheckpoint && isFresh(call!)) {
        batch.checkpoints = [plans.get(planKey(call!.market_id, call!.price))!.checkpoint(call!.end_time + 1)];
      }
      yield batch;
    }
  },
});

export const lighterCandles = candlesSource();
