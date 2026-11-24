import { describeError, systemClock, type Clock, type Source } from "@ingestion/lib";
import { createLighterClient, lighterEnv, type LighterEnv } from "@ingestion/lib/lighter";
import * as z from "zod";

const callSchema = z.object({ kind: z.literal("system_config") });
type SystemConfigCall = z.infer<typeof callSchema>;

const CALL_ID = "system_config";

// One read of the system accounts and limits, kept as one record keyed by read time, so the models can
// see when a role moves to another account. The reply's own `code` stays out of the record.
// A retried read is the same as the run's own read, so it runs once.
export const systemConfigSource = (clock: Clock = systemClock): Source<LighterEnv, SystemConfigCall> => ({
  name: "lighter",
  table: "system_config",
  env: lighterEnv,
  call: callSchema,
  async *extract(env) {
    const lighter = createLighterClient(env, clock);
    const readAt = clock.now();
    try {
      const { code: _code, ...config } = await lighter.get("/api/v1/systemConfig", {}, z.record(z.string(), z.unknown()));
      yield { records: [{ id: String(readAt), callId: CALL_ID, data: { read_at: readAt, config } }], failed: [] };
    } catch (error) {
      yield { records: [], failed: [{ id: CALL_ID, call: { kind: CALL_ID }, error: describeError(error) }] };
    }
  },
});

export const lighterSystemConfig = systemConfigSource();
