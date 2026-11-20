import { DAY_MS, describeError, readJson, uniqueBy, type Source } from "@ingestion/lib";
import {
  accountsFileSchema,
  createLighterClient,
  lighterEnv,
  resolveAccounts,
  systemClock,
  type Clock,
} from "@ingestion/lib/lighter";
import * as z from "zod";

const startTime = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected an ISO date or datetime, such as 2026-10-01 or 2026-10-01T00:00:00Z",
  })
  .transform((value) => Date.parse(value));

const pnlEnv = lighterEnv.extend({ START_TIME: startTime });
export type LighterPnlEnv = z.infer<typeof pnlEnv>;

const RESOLUTIONS = ["1d", "1h"] as const;

const callSchema = z.object({
  kind: z.literal("pnl"),
  account_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  resolution: z.enum(RESOLUTIONS),
});
export type PnlCall = z.infer<typeof callSchema>;

const callId = (call: PnlCall) => `pnl:${call.account_index}:${call.resolution}`;

// Lighter's 1h series covers just under 10 days and answers 22403 for more (catalog/vendors/lighter/NOTES.md,
// Account value). 7 days stays well inside it.
const HOURLY_LOOKBACK_MS = 7 * DAY_MS;
const PERIOD_S = { "1d": 86_400, "1h": 3_600 } as const;

const pnlReply = z.object({ pnl: z.array(z.looseObject({ timestamp: z.number().int() })) });

// Reads each account's whole `1d` series from START_TIME and its last 7 days of `1h` once a run, as two
// calls. Each point is kept as sent, in a record keyed by account, resolution and time: a later run writes
// the same row again, and a point Lighter corrects replaces the old one. Lighter ends a series with a point
// at the request time. That point is open and off the resolution's boundary, so it waits for the next run.
export const pnlSource = (clock: Clock = systemClock): Source<LighterPnlEnv, PnlCall> => ({
  name: "lighter",
  table: "pnl",
  env: pnlEnv,
  call: callSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const file = accountsFileSchema.safeParse(readJson("addresses.json"));
    if (!file.success) throw new Error(`Invalid addresses.json:\n${z.prettifyError(file.error)}`);
    const lighter = createLighterClient(env, clock);
    const nowMs = clock.now();
    const endS = Math.floor(nowMs / 1000);
    const startMs = { "1d": Math.floor(env.START_TIME / DAY_MS) * DAY_MS, "1h": Math.max(env.START_TIME, nowMs - HOURLY_LOOKBACK_MS) };
    const own = (await resolveAccounts(lighter, file.data)).flatMap((account_index) =>
      RESOLUTIONS.map((resolution): PnlCall => ({ kind: "pnl", account_index, resolution })),
    );
    for (const call of uniqueBy([...own, ...retry], callId)) {
      try {
        const reply = await lighter.get("/api/v1/pnl", {
          by: "index",
          value: call.account_index,
          resolution: call.resolution,
          start_timestamp: Math.floor(startMs[call.resolution] / 1000),
          end_timestamp: endS,
          count_back: 0,
        });
        const parsed = pnlReply.safeParse(reply);
        if (!parsed.success) {
          throw new Error(
            `Lighter sent the ${call.resolution} pnl of account ${call.account_index} in an unexpected shape:\n${z.prettifyError(parsed.error)}`,
          );
        }
        const records = parsed.data.pnl
          .filter((point) => point.timestamp % PERIOD_S[call.resolution] === 0)
          .map((point) => ({
            id: `${call.account_index}:${call.resolution}:${point.timestamp}`,
            callId: callId(call),
            data: { account_index: call.account_index, resolution: call.resolution, point },
          }));
        yield { records, failed: [], ...(records.length === 0 ? { succeededCallIds: [callId(call)] } : {}) };
      } catch (error) {
        yield { records: [], failed: [{ id: callId(call), call, error: describeError(error) }] };
      }
    }
  },
});

export const lighterPnl = pnlSource();
