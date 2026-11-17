import { describeError, type Source } from "@ingestion/lib";
import { createLighterClient, lighterEnv, systemClock, type Clock, type LighterEnv } from "@ingestion/lib/lighter";
import * as z from "zod";

const callSchema = z.object({ kind: z.literal("order_book_details") });
type MarketsCall = z.infer<typeof callSchema>;

const CALL_ID = "order_book_details";

// One read lists every perp and spot market with its decimals, fees and minimums. Each market is a
// record, keyed by market and read time, so the models can see how a market's settings change.
// A retried read is the same as the run's own read, so it runs once.
export const marketsSource = (clock: Clock = systemClock): Source<LighterEnv, MarketsCall> => ({
  name: "lighter",
  table: "markets",
  env: lighterEnv,
  call: callSchema,
  async *extract(env) {
    const lighter = createLighterClient(env, clock);
    const readAt = clock.now();
    try {
      const markets = await lighter.markets();
      yield {
        records: markets.map((market) => ({
          id: `${market.market_id}:${readAt}`,
          callId: CALL_ID,
          data: { read_at: readAt, market },
        })),
        failed: [],
        // With no markets there is no record to carry the call id, so name it here to clear a dead letter.
        succeededCallIds: [CALL_ID],
      };
    } catch (error) {
      yield { records: [], failed: [{ id: CALL_ID, call: { kind: CALL_ID }, error: describeError(error) }] };
    }
  },
});

export const lighterMarkets = marketsSource();
