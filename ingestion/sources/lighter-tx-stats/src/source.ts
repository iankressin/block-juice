import { describeError, systemClock, type Clock, type Source } from "@ingestion/lib";
import { createExplorerClient, lighterExplorerEnv, type LighterExplorerEnv } from "@ingestion/lib/lighter";
import * as z from "zod";

const callSchema = z.object({ kind: z.literal("tx_stats") });
type TxStatsCall = z.infer<typeof callSchema>;

const CALL_ID = "tx_stats";
const HOUR_S = 3600;

// Staging reads each point by position, so a changed list must fail the call, not shift the columns.
const TYPES = ["timestamp", "count", "uopsCount"] as const;

const reply = z.object({
  data: z.object({
    chart: z.object({
      types: z.tuple([z.literal(TYPES[0]), z.literal(TYPES[1]), z.literal(TYPES[2])], {
        error: `Lighter's Explorer changed the types of stats/tx: expected ${JSON.stringify(TYPES)}`,
      }),
      data: z.array(z.tuple([z.number().int(), z.number().int(), z.number().int()])),
    }),
  }),
});

// One read sends the whole hourly series, so each run reads it again and a record keeps its hour's
// timestamp as its key. The last point is the hour still open: it waits for a later run.
export const txStatsSource = (clock: Clock = systemClock): Source<LighterExplorerEnv, TxStatsCall> => ({
  name: "lighter",
  table: "tx_stats",
  env: lighterExplorerEnv,
  call: callSchema,
  async *extract(env) {
    const explorer = createExplorerClient(env, clock);
    // Read before the request: an hour is closed when it ended before this moment.
    const readAtS = clock.now() / 1000;
    try {
      const parsed = reply.safeParse(await explorer.txStats());
      if (!parsed.success) {
        throw new Error(`Lighter's Explorer sent stats/tx in an unexpected shape:\n${z.prettifyError(parsed.error)}`);
      }
      const { types, data } = parsed.data.data.chart;
      yield {
        records: data
          .filter(([timestamp]) => timestamp + HOUR_S <= readAtS)
          .map((point) => ({ id: String(point[0]), callId: CALL_ID, data: { types, point } })),
        failed: [],
        // A series with no closed hour has no record to carry the call id.
        succeededCallIds: [CALL_ID],
      };
    } catch (error) {
      yield { records: [], failed: [{ id: CALL_ID, call: { kind: CALL_ID }, error: describeError(error) }] };
    }
  },
});

export const lighterTxStats = txStatsSource();
