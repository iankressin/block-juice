import assert from "node:assert/strict";
import {
  chunk,
  describeError,
  portalClient,
  uniqueBy,
  type Batch,
  type RawRecord,
  type Source,
} from "@ingestion/lib";
import { createEvmClient, evmEnv, type EvmClient } from "@ingestion/lib/evm";
import type { PortalClient } from "@subsquid/pipes/portal-client";
import * as z from "zod";
import { boundaryBlock, finalizedHeadAt, midnight, midnights, portalHeaders, type Header } from "#src/boundary.ts";

const env = evmEnv
  .omit({ BLOCK_NUMBER: true })
  .extend({
    // The chain's Portal dataset, set in chains/<chain>/.env.example.
    PORTAL_URL: z.url(),
    // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
    PORTAL_API_KEY: z.string().optional(),
    // The first UTC day whose starting midnight to read, YYYY-MM-DD.
    START_DATE: z.iso.date(),
    // The last such day. Unset, each run reads to the last midnight Portal's finalized head has passed.
    END_DATE: z.iso.date().optional(),
  })
  .refine((e) => e.END_DATE === undefined || e.START_DATE <= e.END_DATE, {
    message: "END_DATE must not be before START_DATE",
  });

export type HeadersEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

export const headersCallSchema = z.object({ kind: z.literal("block_headers"), midnight });

export type HeadersCall = z.infer<typeof headersCallSchema>;

// Each midnight reads Portal about four times and the RPC twice, so a few at once stay under public limits.
const MIDNIGHTS_PER_BATCH = 5;

export const headersCallsAt = (at: readonly string[]): HeadersCall[] =>
  at.map((m) => ({ kind: "block_headers", midnight: m }));

async function rpcHeader(client: EvmClient, block: number): Promise<Header> {
  const { number, hash, parentHash, timestamp } = await client.getBlock({ blockNumber: BigInt(block) });
  assert(number !== null && hash !== null, `the RPC sent block ${block} without its number or hash`);
  return { number: Number(number), hash, parentHash, timestamp: Number(timestamp) };
}

function headerRecord(origin: "portal" | "rpc", header: Header, callId: string): RawRecord {
  return {
    id: `${origin}:${header.number}`,
    callId,
    data: {
      kind: "header",
      origin,
      number: header.number,
      hash: header.hash,
      parent_hash: header.parentHash,
      parent_number: header.number - 1,
      timestamp: new Date(header.timestamp * 1000).toISOString(),
    },
  };
}

/**
 * One midnight's records: B, the first block at or after it by Portal's headers, as found, and the
 * headers of B - 1 and B from Portal and from the RPC, as each sends them. dbt checks they agree.
 */
async function boundaryRecords(portal: PortalClient, client: EvmClient, head: number, call: HeadersCall): Promise<RawRecord[]> {
  const header = portalHeaders(portal);
  const block = await boundaryBlock(portal, header, head, call.midnight);
  const [fromPortal, fromRpc] = await Promise.all([
    Promise.all([header(block - 1), header(block)]),
    Promise.all([rpcHeader(client, block - 1), rpcHeader(client, block)]),
  ]);
  return [
    { id: `boundary:${call.midnight}`, callId: call.midnight, data: { kind: "boundary", midnight: call.midnight, block } },
    ...fromPortal.map((h) => headerRecord("portal", h, call.midnight)),
    ...fromRpc.map((h) => headerRecord("rpc", h, call.midnight)),
  ];
}

/**
 * The records of each midnight, a few midnights a batch. A midnight whose reads fail becomes a failed
 * call under its own id, the callId of its records, and waits for the next run.
 */
export async function* readBoundaries(
  portal: PortalClient,
  client: EvmClient,
  head: number,
  calls: readonly HeadersCall[],
): AsyncIterable<Batch<HeadersCall>> {
  for (const group of chunk(uniqueBy(calls, (c) => c.midnight), MIDNIGHTS_PER_BATCH)) {
    const outcomes = await Promise.allSettled(group.map((call) => boundaryRecords(portal, client, head, call)));
    const batch: Batch<HeadersCall> = { records: [], failed: [] };
    outcomes.forEach((outcome, i) => {
      const call = group[i]!;
      if (outcome.status === "fulfilled") batch.records.push(...outcome.value);
      else batch.failed.push({ id: call.midnight, call, error: describeError(outcome.reason) });
    });
    yield batch;
  }
}

/**
 * For each UTC midnight from START_DATE that Portal's finalized head has passed, up to END_DATE: the
 * first block at or after it, and the headers on both sides of it from Portal and from EVM_RPC_URL.
 * Each run reads every midnight again and writes the same ids. The source is named for its chain, so
 * each chain loads into raw.<chain>_block_headers.
 */
export const forChain = (chain: string): Source<HeadersEnv, HeadersCall> => ({
  name: chainName.parse(chain),
  table: "block_headers",
  env,
  call: headersCallSchema,
  async *extract(env, retry) {
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const client = createEvmClient(env.EVM_RPC_URL, { batchSize: env.RPC_BATCH_SIZE, maxConcurrency: env.RPC_MAX_CONCURRENCY });
    const head = await finalizedHeadAt(portal);
    const calls = [...headersCallsAt(midnights(env.START_DATE, env.END_DATE, head.time)), ...retry];
    yield* readBoundaries(portal, client, head.block, calls);
  },
});
