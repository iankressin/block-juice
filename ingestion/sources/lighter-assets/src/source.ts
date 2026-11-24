import { describeError, systemClock, type Clock, type Source } from "@ingestion/lib";
import { createLighterClient, lighterEnv, type LighterEnv } from "@ingestion/lib/lighter";
import * as z from "zod";

const callSchema = z.object({ kind: z.literal("asset_details") });
type AssetsCall = z.infer<typeof callSchema>;

const CALL_ID = "asset_details";

const assetEntry = z.looseObject({ asset_id: z.number() });
const assetsReply = z.object({ asset_details: z.array(assetEntry) });

// One read lists every asset with its decimals, L1 address, caps and index price. Each asset is a
// record keyed by asset and read time, so the models can see how an asset's settings change.
// A retried read is the same as the run's own read, so it runs once.
export const assetsSource = (clock: Clock = systemClock): Source<LighterEnv, AssetsCall> => ({
  name: "lighter",
  table: "assets",
  env: lighterEnv,
  call: callSchema,
  async *extract(env) {
    const lighter = createLighterClient(env, clock);
    const readAt = clock.now();
    try {
      const reply = await lighter.get("/api/v1/assetDetails", {}, assetsReply);
      yield {
        records: reply.asset_details.map((asset) => ({
          id: `${asset.asset_id}:${readAt}`,
          callId: CALL_ID,
          data: { read_at: readAt, asset },
        })),
        failed: [],
        // With no assets there is no record to carry the call id, so name it here to clear a dead letter.
        succeededCallIds: [CALL_ID],
      };
    } catch (error) {
      yield { records: [], failed: [{ id: CALL_ID, call: { kind: CALL_ID }, error: describeError(error) }] };
    }
  },
});

export const lighterAssets = assetsSource();
