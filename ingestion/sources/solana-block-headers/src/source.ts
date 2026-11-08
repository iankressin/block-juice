import assert from "node:assert/strict";
import {
  describeError,
  finalizedHead,
  portalClient,
  uniqueBy,
  type Batch,
  type Source,
} from "@ingestion/lib";
import { createSolanaClient, type SolanaClient } from "@ingestion/lib/solana";
import type { PortalClient } from "@subsquid/pipes/portal-client";
import * as z from "zod";
import {
  boundaryHeaders,
  boundaryRecords,
  pacer,
  portalHeaders,
  rpcHeader,
} from "#src/headers.ts";

const DAY_MS = 86_400_000;
/** A run reads at most this many midnights, so START_DATE cannot ask for unbounded work. */
export const MIDNIGHTS_MAX = 1_000;

const headersEnv = z
  .object({
    // The Solana Portal dataset.
    PORTAL_URL: z.url(),
    // Sent with every Portal request when set. Without one, the public Portal answers at its
    // anonymous limits.
    PORTAL_API_KEY: z.string().optional(),
    // Reads past blocks with getBlock. The public RPC refuses bursts.
    SOLANA_RPC_URL: z.url().default("https://api.mainnet-beta.solana.com"),
    // The least time between two RPC calls. About 2s drains the public RPC's refusals.
    SOLANA_RPC_INTERVAL_MS: z.coerce.number().int().nonnegative().default(2_000),
    // The first UTC midnight to read, as a date.
    START_DATE: z.iso.date(),
    // The last UTC midnight to read. Unset, each run reads up to the last midnight Portal has
    // finalized.
    END_DATE: z.iso.date().optional(),
  })
  .refine((env) => env.END_DATE === undefined || env.START_DATE <= env.END_DATE, {
    message: "END_DATE must not be before START_DATE",
  });

export type HeadersEnv = z.infer<typeof headersEnv>;

export const midnightCall = z.object({
  kind: z.literal("block_headers"),
  midnight: z.iso.datetime(),
});
export type MidnightCall = z.infer<typeof midnightCall>;

/**
 * Each UTC midnight from START_DATE up to END_DATE and to the last midnight at or before `head_ms`,
 * Portal's finalized head time. A midnight is an ISO string, which keys its call.
 */
export function midnights(
  env: Pick<HeadersEnv, "START_DATE" | "END_DATE">,
  head_ms: number,
): string[] {
  const first = Date.parse(`${env.START_DATE}T00:00:00Z`);
  const finalized = Math.floor(head_ms / DAY_MS) * DAY_MS;
  const end = env.END_DATE === undefined ? Infinity : Date.parse(`${env.END_DATE}T00:00:00Z`);
  const last = Math.min(finalized, end);
  const count = last < first ? 0 : (last - first) / DAY_MS + 1;
  assert.ok(Number.isInteger(count));
  if (count > MIDNIGHTS_MAX) {
    throw new Error(
      `START_DATE ${env.START_DATE} asks for ${count} midnights, more than ${MIDNIGHTS_MAX} ` +
        "a run: set a later START_DATE or an END_DATE",
    );
  }
  return Array.from({ length: count }, (_, day) => new Date(first + day * DAY_MS).toISOString());
}

// Each UTC midnight's boundary on Solana: Portal's first produced slot at or after it, and the
// headers of that slot and of the last produced slot below it, as Portal and as the RPC state them.
// Whether they agree, and which day each slot belongs to, is dbt's to work out.
export const solanaBlockHeaders: Source<HeadersEnv, MidnightCall> = {
  name: "solana",
  table: "block_headers",
  env: headersEnv,
  call: midnightCall,
  async *extract(env, retry) {
    assert.ok(retry.length <= MIDNIGHTS_MAX, "each run that left dead letters read MIDNIGHTS_MAX");
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const head = await finalizedHead(portal);
    const [top] = await portalHeaders(portal, head, head, 1);
    if (top === undefined) throw new Error(`Portal has no header for its finalized head ${head}`);
    const fresh = midnights(env, Date.parse(top.timestamp!)).map(
      (midnight): MidnightCall => ({ kind: "block_headers", midnight }),
    );
    const read = readMidnight({
      portal,
      rpc: createSolanaClient(env.SOLANA_RPC_URL, { maxConcurrency: 1 }),
      head,
      pace: pacer(env.SOLANA_RPC_INTERVAL_MS),
    });
    // One batch a midnight, so a long run commits as it goes.
    for (const call of uniqueBy([...fresh, ...retry], (call) => call.midnight)) {
      yield await read(call);
    }
  },
};

type Reader = { portal: PortalClient; rpc: SolanaClient; head: number; pace: () => Promise<void> };

/** One midnight's records, or its failed call when Portal or the RPC fails it. */
const readMidnight =
  ({ portal, rpc, head, pace }: Reader) =>
  async (call: MidnightCall): Promise<Batch<MidnightCall>> => {
    try {
      const [previous, boundary] = await boundaryHeaders(portal, new Date(call.midnight), head);
      const stated = [];
      for (const slot of [previous.number, boundary.number]) {
        await pace();
        stated.push(await rpcHeader(rpc, slot));
      }
      const headers = [previous, boundary, ...stated];
      return { records: boundaryRecords(call.midnight, boundary.number, headers), failed: [] };
    } catch (error) {
      return { records: [], failed: [{ id: call.midnight, call, error: describeError(error) }] };
    }
  };
