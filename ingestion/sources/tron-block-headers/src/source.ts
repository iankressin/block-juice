import assert from "node:assert/strict";
import {
  describeError,
  finalizedHead,
  logger,
  portalClient,
  uniqueBy,
  type Batch,
  type RawRecord,
  type Source,
} from "@ingestion/lib";
import type { PortalClient } from "@subsquid/pipes/portal-client";
import * as z from "zod";
import { portalHeaders, tronHttp, type Header, type TronHttp } from "#src/header.ts";
import { firstBlockAtOrAfter } from "#src/search.ts";

const log = logger.child({ source: "tron", table: "block_headers" });
const DAY_MS = 86_400_000;
// One call per midnight, and every run calls them all again, so a run past this many days would
// take hours; move START_DATE forward instead.
const MIDNIGHTS_MAX = 1_000;

const env = z
  .object({
    // tron-mainnet's Portal dataset.
    PORTAL_URL: z.url(),
    // Sent with every Portal request when set. Without one, the public Portal answers at its
    // anonymous limits.
    PORTAL_API_KEY: z.string().optional(),
    // TRON's HTTP API, which serves wallet/getblockbynum.
    TRON_HTTP_URL: z.url(),
    // Sent as TRON-PRO-API-KEY when set. Without one, TronGrid answers at its anonymous limits.
    TRON_API_KEY: z.string().optional(),
    // The least time between two TRON HTTP requests.
    TRON_HTTP_INTERVAL_MS: z.coerce.number().int().nonnegative().max(60_000).default(1_000),
    // The first UTC midnight to call, as YYYY-MM-DD.
    START_DATE: z.iso.date(),
    // The last UTC midnight to call. Unset, calls end at the last midnight at or before the
    // timestamp of Portal's finalized head.
    END_DATE: z.iso.date().optional(),
  })
  .refine((e) => e.END_DATE === undefined || e.END_DATE >= e.START_DATE, {
    message: "END_DATE must not be before START_DATE",
  });

export type TronBlockHeadersEnv = z.infer<typeof env>;

const isMidnight = (iso: string) => Date.parse(iso) % DAY_MS === 0;

// One spelling per midnight, as toISOString writes it, so a retried call keeps its record ids.
const midnightCallSchema = z.object({
  midnight: z.iso
    .datetime()
    .refine(isMidnight, "Expected a UTC midnight")
    .transform((iso) => new Date(iso).toISOString()),
});

export type MidnightCall = z.infer<typeof midnightCallSchema>;

/** The midnights from START_DATE to END_DATE, or to the last one at or before `headMs`. */
function midnightCalls(startDate: string, endDate: string | undefined, headMs: number) {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = endDate === undefined ? Infinity : Date.parse(`${endDate}T00:00:00Z`);
  const lastMs = Math.min(endMs, headMs);
  const count = lastMs < startMs ? 0 : Math.floor((lastMs - startMs) / DAY_MS) + 1;
  if (count > MIDNIGHTS_MAX) {
    throw new Error(`${count} midnights from ${startDate}, more than ${MIDNIGHTS_MAX} a run`);
  }
  const calls = Array.from({ length: count }, (_, i) => ({
    midnight: new Date(startMs + i * DAY_MS).toISOString(),
  }));
  assert.ok(calls.every((call) => isMidnight(call.midnight)));
  return calls;
}

function headerRecord(origin: "portal" | "rpc", header: Header, callId: string): RawRecord {
  assert.ok(header.number >= 1);
  const data = {
    kind: "header",
    origin,
    number: header.number,
    hash: header.hash,
    parent_hash: header.parentHash,
    parent_number: header.number - 1,
    timestamp: new Date(header.timestampMs).toISOString(),
  };
  return { id: `${origin}:${header.number}`, callId, data };
}

type Clients = { portal: PortalClient; tron: TronHttp; head: number };

/**
 * One midnight's records: B, the first block at or after it on Portal, and the headers of B - 1
 * and B from Portal and from TRON's HTTP API. Portal's timestamps route answers only near B on
 * TRON (minutes early), so it is the search's starting guess, not B.
 */
async function boundaryRecords({ portal, tron, head }: Clients, { midnight }: MidnightCall) {
  const midnightMs = Date.parse(midnight);
  const guess = await portal.resolveTimestamp(midnightMs / 1000);
  const timestamps = new Map<number, number>();
  const timestampOf = async (block: number) => {
    if (!timestamps.has(block)) {
      const [header] = await portalHeaders(portal, block, block);
      timestamps.set(block, header!.timestampMs);
    }
    return timestamps.get(block)!;
  };
  const block = await firstBlockAtOrAfter(midnightMs, guess, head, timestampOf);
  if (block > head) throw new Error(`No block at or after ${midnight} up to Portal's head ${head}`);
  assert.ok(block >= 1, "the boundary has a block before it");
  log.info({ midnight, guess, block, probes: timestamps.size }, "Boundary found");

  const [before, at] = await portalHeaders(portal, block - 1, block);
  assert.ok(before!.timestampMs < midnightMs, "the block before the boundary is earlier");
  assert.ok(at!.timestampMs >= midnightMs, "the boundary is at or after midnight");
  const rpc = [await tron.header(block - 1), await tron.header(block)];
  return [
    { id: `boundary:${midnight}`, callId: midnight, data: { kind: "boundary", midnight, block } },
    headerRecord("portal", before!, midnight),
    headerRecord("portal", at!, midnight),
    ...rpc.map((header) => headerRecord("rpc", header, midnight)),
  ];
}

/**
 * For each UTC midnight from START_DATE that Portal's finalized head has passed, plus the
 * midnights that failed in earlier runs: the boundary block and the headers on both sides of it,
 * from Portal and from TRON's HTTP API, so dbt can check the day's edges against both.
 */
export const tronBlockHeaders: Source<TronBlockHeadersEnv, MidnightCall> = {
  name: "tron",
  table: "block_headers",
  env,
  call: midnightCallSchema,
  async *extract(env, retry) {
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const head = await finalizedHead(portal);
    const [headHeader] = await portalHeaders(portal, head, head);
    const fresh = midnightCalls(env.START_DATE, env.END_DATE, headHeader!.timestampMs);
    const calls = uniqueBy([...fresh, ...retry], (call) => call.midnight);
    if (calls.length > MIDNIGHTS_MAX) {
      throw new Error(`${calls.length} midnights to call, more than ${MIDNIGHTS_MAX} a run`);
    }
    const tron = tronHttp({
      url: env.TRON_HTTP_URL,
      apiKey: env.TRON_API_KEY,
      intervalMs: env.TRON_HTTP_INTERVAL_MS,
    });
    for (const call of calls) {
      const batch: Batch<MidnightCall> = { records: [], failed: [] };
      try {
        batch.records.push(...(await boundaryRecords({ portal, tron, head }, call)));
      } catch (error) {
        // A broken invariant is a bug, not a call to retry next run.
        if (error instanceof assert.AssertionError) throw error;
        batch.failed.push({ id: call.midnight, call, error: describeError(error) });
      }
      yield batch;
    }
  },
};
