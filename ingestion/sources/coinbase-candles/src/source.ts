import { readJson, callBatches, chunk, historyKey, historyPlan, historyState, type Source } from "@ingestion/lib";
import * as z from "zod";
import { createCoinbaseClient, systemClock, type Clock } from "#src/coinbase.ts";
import {
  callId,
  candleCallSchema,
  checkMarket,
  fetchWindows,
  interval,
  parseTokens,
  iterateWindowCalls,
  windowSpan,
  bucketStart,
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

const coinbaseEnv = z.object({
  // Coinbase Exchange's public market-data API, which needs no key.
  COINBASE_API_URL: z.url().default("https://api.exchange.coinbase.com"),
  CANDLE_INTERVAL: interval.default("1h"),
  START_TIME: startTime,
  HISTORY_OVERLAP_DAYS: z.coerce.number().int().nonnegative().optional(),
  HISTORY_REFRESH_DAYS: z.coerce.number().int().positive().optional(),
  HISTORY_FULL_REFRESH: z.enum(["0", "1"]).optional(),
  // A chunk sends this many requests at once, one chunk a second, so it must stay within Coinbase's
  // 10 public requests a second.
  COINBASE_MAX_CONCURRENCY: z.coerce.number().int().positive().max(10).default(5),
});

export type CoinbaseEnv = z.infer<typeof coinbaseEnv>;

// Backfill each token from START_TIME, then refresh recent windows and periodic historical
// corrections. Each call holds at most 300 candles; failed windows retain their own retries.
export const candlesSource = (clock: Clock = systemClock): Source<CoinbaseEnv, CandleCall> => ({
  name: "coinbase",
  table: "candles",
  env: coinbaseEnv,
  call: candleCallSchema,
  retryMode: "paged",
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad tokens.json.
    const tokens = readJson(new URL("../tokens.json", import.meta.url));
    const markets = parseTokens(tokens);
    const coinbase = createCoinbaseClient(env.COINBASE_API_URL, clock);

    for (const part of chunk(markets, env.COINBASE_MAX_CONCURRENCY)) {
      await coinbase.waitForRate();
      await Promise.all(part.map((market) => checkMarket(coinbase, market)));
    }
    const now = clock.now();
    const span = windowSpan(env.CANDLE_INTERVAL);
    const plans = new Map<string, ReturnType<typeof historyPlan>>();
    for (const market of markets) {
      const key = historyKey(["coinbase", env.COINBASE_API_URL, market, env.CANDLE_INTERVAL, env.START_TIME]);
      const saved = historyState(await context?.getCheckpoint?.(key));
      const origin = saved?.origin ?? bucketStart(env.START_TIME, env.CANDLE_INTERVAL);
      plans.set(market.product_id, historyPlan(key, origin, span, now, saved, env));
    }
    function* fresh() {
      for (const market of markets) yield* iterateWindowCalls(market, env.CANDLE_INTERVAL, plans.get(market.product_id)!.from, now);
    }
    const isFresh = (call: CandleCall) => {
      const plan = plans.get(call.product_id);
      return !!plan && call.interval === env.CANDLE_INTERVAL && call.start_time >= plan.from && call.start_time <= now
        && (call.start_time - plan.from) % span === 0;
    };
    for await (const part of callBatches(fresh(), retry, callId, isFresh, context, env.COINBASE_MAX_CONCURRENCY, true)) {
      await coinbase.waitForRate();
      const batch = await fetchWindows(coinbase, part, clock);
      if (context?.getCheckpoint) {
        const progress = new Map<string, ReturnType<ReturnType<typeof historyPlan>["checkpoint"]>>();
        for (const call of part) if (isFresh(call)) {
          const checkpoint = plans.get(call.product_id)!.checkpoint(call.end_time + 1);
          progress.set(checkpoint.key, checkpoint);
        }
        batch.checkpoints = [...progress.values()];
      }
      yield batch;
    }
  },
});

export const coinbaseCandles = candlesSource();
