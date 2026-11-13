import { callBatches, chunk, historyKey, historyPlan, historyState, type Source } from "@ingestion/lib";
import * as z from "zod";
import { createBinanceClient, systemClock, type Clock } from "#src/binance.ts";
import {
  callId,
  fetchWindows,
  firstOpenTime,
  interval,
  candleCallSchema,
  parseTokens,
  iterateWindowCalls,
  windowSpan,
  type CandleCall,
} from "#src/candles.ts";

const startTime = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected an ISO date or datetime, such as 2026-10-01 or 2026-10-01T00:00:00Z",
  })
  .transform((value) => Date.parse(value));

const binanceEnv = z.object({
  // Binance's market-data-only host. api.binance.com refuses requests from some regions.
  BINANCE_API_URL: z.url().default("https://data-api.binance.vision"),
  CANDLE_INTERVAL: interval.default("1h"),
  START_TIME: startTime,
  HISTORY_OVERLAP_DAYS: z.coerce.number().int().nonnegative().optional(),
  HISTORY_REFRESH_DAYS: z.coerce.number().int().positive().optional(),
  HISTORY_FULL_REFRESH: z.enum(["0", "1"]).optional(),
  // A chunk sends this many requests of weight 2 at once after the weight check, so it must fit in the
  // 1000 weight between the client's 5000 budget and Binance's limit of 6000.
  BINANCE_MAX_CONCURRENCY: z.coerce.number().int().positive().max(100).default(5),
});

export type BinanceEnv = z.infer<typeof binanceEnv>;

// Backfill each token from START_TIME, then refresh recent windows and periodic historical
// corrections. Each call holds at most 1000 candles; failed windows retain their own retries.
export const candlesSource = (clock: Clock = systemClock): Source<BinanceEnv, CandleCall> => ({
  name: "binance",
  table: "candles",
  env: binanceEnv,
  call: candleCallSchema,
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad tokens.json.
    const { default: tokens } = await import("../tokens.json", { with: { type: "json" } });
    const markets = parseTokens(tokens);
    const binance = createBinanceClient(env.BINANCE_API_URL, clock);

    const now = clock.now();
    const span = windowSpan(env.CANDLE_INTERVAL);
    const plans = new Map<string, ReturnType<typeof historyPlan>>();
    for (const market of markets) {
      const key = historyKey(["binance", env.BINANCE_API_URL, market, env.CANDLE_INTERVAL, env.START_TIME]);
      const saved = historyState(await context?.getCheckpoint?.(key));
      if (!saved) await binance.waitForWeight();
      const origin = saved?.origin ?? await firstOpenTime(binance, market, env.CANDLE_INTERVAL, env.START_TIME);
      plans.set(market.symbol, historyPlan(key, origin, span, now, saved, env));
    }
    function* fresh() {
      for (const market of markets) yield* iterateWindowCalls(market, env.CANDLE_INTERVAL, plans.get(market.symbol)!.from, now);
    }
    const isFresh = (call: CandleCall) => {
      const plan = plans.get(call.symbol);
      return !!plan && call.interval === env.CANDLE_INTERVAL && call.start_time >= plan.from && call.start_time <= now
        && (call.start_time - plan.from) % span === 0;
    };
    for await (const part of callBatches(fresh(), retry, callId, isFresh, context, env.BINANCE_MAX_CONCURRENCY, true)) {
      await binance.waitForWeight();
      const batch = await fetchWindows(binance, part, clock);
      if (context?.getCheckpoint) {
        const progress = new Map<string, ReturnType<ReturnType<typeof historyPlan>["checkpoint"]>>();
        for (const call of part) if (isFresh(call)) {
          const checkpoint = plans.get(call.symbol)!.checkpoint(call.end_time + 1);
          progress.set(checkpoint.key, checkpoint);
        }
        batch.checkpoints = [...progress.values()];
      }
      yield batch;
    }
  },
});

export const binanceCandles = candlesSource();
