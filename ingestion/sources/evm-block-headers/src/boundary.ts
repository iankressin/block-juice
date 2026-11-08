import assert from "node:assert/strict";
import { finalizedHead } from "@ingestion/lib";
import type { PortalClient } from "@subsquid/pipes/portal-client";
import * as z from "zod";

// The same file is in evm-block-headers and evm-erc20-supply, which read the same midnights. Its home
// is ingestion/lib/src/evm once lib may change; until then a test in evm-erc20-supply keeps the copies equal.

const DAY_MS = 86_400_000;

/** The most midnights one run reads. */
export const MAX_MIDNIGHTS = 1_000;

// Doubling away from a guess and then halving the bracket take about 2 * log2(head) + 2 header reads.
// That is 52 for Ethereum's head near 2^25, and 64 for any chain below 2^31 blocks.
const MAX_HEADER_READS = 64;

/** A UTC midnight as an ISO string, such as 2026-10-08T00:00:00.000Z. */
export const midnight = z.iso
  .datetime()
  .refine((t) => t.endsWith("T00:00:00.000Z"), "Expected a UTC midnight such as 2026-10-08T00:00:00.000Z");

/**
 * Every UTC midnight from `start` to `end`, both YYYY-MM-DD, that is at or before `head`, the time of
 * Portal's finalized head. Unset, `end` is the last midnight at or before `head`.
 */
export function midnights(start: string, end: string | undefined, head: Date): string[] {
  const first = Date.parse(`${start}T00:00:00.000Z`);
  const reached = Math.floor(head.getTime() / DAY_MS) * DAY_MS;
  const last = end === undefined ? reached : Math.min(Date.parse(`${end}T00:00:00.000Z`), reached);
  assert(Number.isFinite(first) && Number.isFinite(last), `${start} or ${end} is not a date`);
  if (last < first) return [];
  const count = (last - first) / DAY_MS + 1;
  if (count > MAX_MIDNIGHTS) {
    throw new Error(
      `${start} to ${new Date(last).toISOString().slice(0, 10)} holds ${count} midnights, more than the ` +
        `${MAX_MIDNIGHTS} a run reads: set END_DATE`,
    );
  }
  return Array.from({ length: count }, (_, i) => new Date(first + i * DAY_MS).toISOString());
}

/** A block header as Portal sends it. `timestamp` is in unix seconds. */
export type Header = { number: number; hash: string; parentHash: string; timestamp: number };

const HEADER_FIELDS = { block: { number: true, hash: true, parentHash: true, timestamp: true } } as const;

/**
 * Reads one block's header from Portal at a time, each block once. The client reads the stream again
 * from the next block when a response stops early, so the loop ends once the block has arrived.
 */
export function portalHeaders(portal: PortalClient): (block: number) => Promise<Header> {
  const read = new Map<number, Promise<Header>>();
  return (block) => {
    let header = read.get(block);
    if (header === undefined) {
      header = (async () => {
        const query = { type: "evm", fromBlock: block, toBlock: block, includeAllBlocks: true, fields: HEADER_FIELDS } as const;
        for await (const { blocks } of portal.getStream(query)) {
          const found = blocks.find((b) => b.header.number === block);
          if (found) return found.header;
        }
        throw new Error(`Portal sent no header for block ${block}`);
      })();
      read.set(block, header);
    }
    return header;
  };
}

/** Portal's finalized head and its time. No midnight after that time has a first block yet. */
export async function finalizedHeadAt(portal: PortalClient): Promise<{ block: number; time: Date }> {
  const block = await finalizedHead(portal);
  const { timestamp } = await portalHeaders(portal)(block);
  return { block, time: new Date(timestamp * 1000) };
}

/** Blocks low and high with low <= the first block at or after `time` <= high, found by steps away from `guess` that double. */
async function around(
  time: number,
  guess: number,
  head: number,
  timestampOf: (block: number) => Promise<number>,
): Promise<[number, number]> {
  let step = 1;
  if ((await timestampOf(guess)) >= time) {
    let high = guess;
    while (high > 0) {
      const probe = Math.max(guess - step, 0);
      if ((await timestampOf(probe)) < time) return [probe + 1, high];
      [high, step] = [probe, step * 2];
    }
    return [0, 0];
  }
  let low = guess + 1;
  while (low <= head) {
    const probe = Math.min(guess + step, head);
    if ((await timestampOf(probe)) >= time) return [low, probe];
    [low, step] = [probe + 1, step * 2];
  }
  return [head + 1, head + 1];
}

/**
 * The first block whose timestamp is at or after `time`, in unix seconds, or head + 1 when every block
 * is earlier. Timestamps never decrease, so a binary search finds it; a guess near it narrows the search
 * first. The same search as `first_block_at_or_after` in orchestration/pipeline/cli/blocks.py.
 */
export async function firstBlockAtOrAfter(
  time: number,
  guess: number,
  head: number,
  timestampOf: (block: number) => Promise<number>,
): Promise<number> {
  let reads = 0;
  const bounded = (block: number) => {
    reads += 1;
    assert(reads <= MAX_HEADER_READS, `the search for the first block at or after ${time} read more than ${MAX_HEADER_READS} headers`);
    return timestampOf(block);
  };
  let [low, high] = await around(time, Math.min(Math.max(guess, 0), head), head, bounded);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await bounded(middle)) >= time) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * B for a midnight: the first block whose Portal header is at or after it. Portal's /timestamps route
 * gives only a guess, since it is off by minutes to hours on some datasets; Portal's headers decide.
 */
export async function boundaryBlock(
  portal: PortalClient,
  header: (block: number) => Promise<Header>,
  head: number,
  at: string,
): Promise<number> {
  const time = Date.parse(at) / 1000;
  const guess = await portal.resolveTimestamp(time);
  const block = await firstBlockAtOrAfter(time, guess, head, async (n) => (await header(n)).timestamp);
  assert(block >= 1 && block <= head, `the first block at or after ${at} is ${block}, outside 1 to Portal's finalized head ${head}`);
  return block;
}
