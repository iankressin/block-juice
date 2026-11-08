import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { RawRecord } from "@ingestion/lib";
import type { SolanaClient } from "@ingestion/lib/solana";
import type { PortalClient } from "@subsquid/pipes/portal-client";
import * as z from "zod";

/** One block header as one origin states it. Times are ISO-8601 UTC; a Solana RPC may have none. */
export type Header = {
  kind: "header";
  origin: "portal" | "rpc";
  number: number;
  hash: string;
  parent_hash: string;
  parent_number: number;
  timestamp: string | null;
};

// Each step doubles, so this many steps reach past any slot number.
const STEPS_MAX = 64;

const portalHeader = z.object({
  number: z.number().int().nonnegative(),
  hash: z.string().min(1),
  parentNumber: z.number().int().nonnegative(),
  parentHash: z.string().min(1),
  timestamp: z.number().int().nonnegative(),
});

/**
 * The headers of the first `limit` produced slots from `from`, ascending, from Portal. A skipped
 * slot has no header. The range ends at `head`, Portal's finalized head, which is a produced slot:
 * Portal answers a range of skipped slots with an empty body, and Pipes' client then asks for it
 * again without end. The read stops after `limit` headers, so it does not read to the head.
 */
export async function portalHeaders(
  portal: PortalClient,
  from: number,
  head: number,
  limit: number,
): Promise<Header[]> {
  assert.ok(from <= head);
  assert.ok(limit > 0);
  const block = { number: true, hash: true, parentNumber: true, parentHash: true, timestamp: true };
  const query = {
    type: "solana",
    fromBlock: from,
    toBlock: head,
    includeAllBlocks: true,
    fields: { block },
  } as const;
  const headers: Header[] = [];
  for await (const { blocks } of portal.getStream(query)) {
    for (const block of blocks) {
      const header = portalHeader.parse(block.header);
      assert.ok(header.number >= from && header.number <= head, "Portal answers inside the range");
      headers.push({
        kind: "header",
        origin: "portal",
        number: header.number,
        hash: header.hash,
        parent_hash: header.parentHash,
        parent_number: header.parentNumber,
        timestamp: new Date(header.timestamp * 1000).toISOString(),
      });
      if (headers.length === limit) return headers;
    }
  }
  return headers;
}

/**
 * Portal's first produced slot B at or after `midnight`, and the last produced slot below it, as
 * [previous, B]. Portal's timestamp route is only a guess, as it can be hours off (2026-10-08). The
 * search reads headers around the guess, so B is the first slot whose header time is at or after
 * midnight.
 */
export async function boundaryHeaders(portal: PortalClient, midnight: Date, head: number) {
  const time = midnight.getTime() / 1000;
  assert.ok(Number.isInteger(time));
  const guess = await portal.resolveTimestamp(time);
  const timeAt = async (slot: number) => {
    const [first] = await portalHeaders(portal, slot, head, 1);
    assert.ok(first !== undefined, "the head is a produced slot at or after any slot up to it");
    return Date.parse(first.timestamp!) / 1000;
  };
  const after = await firstSlotAtOrAfter(time, Math.min(Math.max(guess, 0), head), head, timeAt);
  if (after === 0 || after > head) {
    throw new Error(`No produced slot on both sides of ${midnight.toISOString()} up to ${head}`);
  }
  // The search ends one past the last produced slot that comes before midnight.
  const [previous, boundary] = await portalHeaders(portal, after - 1, head, 2);
  assert.ok(previous !== undefined);
  assert.ok(boundary !== undefined);
  assert.equal(previous.number, after - 1, "the slot below the search's end is produced");
  assert.ok(Date.parse(previous.timestamp!) < midnight.getTime());
  assert.ok(Date.parse(boundary.timestamp!) >= midnight.getTime());
  return [previous, boundary] as const;
}

/**
 * The least slot p with `timeAt(p) >= time`, where `timeAt(p)` is the time of the first produced
 * slot at or after p, so it never falls as p rises. It steps away from `guess` in steps that double
 * until it brackets p, then halves the bracket, as `around` and `first_block_at_or_after` do in
 * orchestration/pipeline/cli/blocks.py. head + 1 when every slot up to `head` is earlier.
 */
export async function firstSlotAtOrAfter(
  time: number,
  guess: number,
  head: number,
  timeAt: (slot: number) => Promise<number>,
): Promise<number> {
  assert.ok(guess >= 0 && guess <= head);
  let [low, high] = await bracket(time, guess, head, timeAt);
  for (let step = 0; low < high; step++) {
    assert.ok(step < STEPS_MAX, "halving ends within STEPS_MAX steps");
    const middle = Math.floor((low + high) / 2);
    if ((await timeAt(middle)) >= time) high = middle;
    else low = middle + 1;
  }
  assert.ok(low >= 0 && low <= head + 1);
  return low;
}

/** Slots low <= p <= high, found by stepping away from `guess` in steps that double. */
async function bracket(
  time: number,
  guess: number,
  head: number,
  timeAt: (slot: number) => Promise<number>,
): Promise<[number, number]> {
  let step = 1;
  if ((await timeAt(guess)) >= time) {
    let high = guess;
    for (let steps = 0; high > 0; steps++) {
      assert.ok(steps < STEPS_MAX, "stepping down ends within STEPS_MAX steps");
      const probe = Math.max(guess - step, 0);
      if ((await timeAt(probe)) < time) return [probe + 1, high];
      [high, step] = [probe, step * 2];
    }
    return [0, 0];
  }
  let low = guess + 1;
  for (let steps = 0; low <= head; steps++) {
    assert.ok(steps < STEPS_MAX, "stepping up ends within STEPS_MAX steps");
    const probe = Math.min(guess + step, head);
    if ((await timeAt(probe)) >= time) return [low, probe];
    [low, step] = [probe + 1, step * 2];
  }
  return [head + 1, head + 1];
}

/** The header of `slot` as the RPC states it, at finalized commitment. */
export async function rpcHeader(rpc: SolanaClient, slot: number): Promise<Header> {
  assert.ok(Number.isSafeInteger(slot) && slot >= 0);
  const block = await rpc
    .getBlock(BigInt(slot), {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
      rewards: false,
      transactionDetails: "none",
    })
    .send();
  if (block === null) throw new Error(`The RPC has no finalized block at slot ${slot}`);
  const parent = Number(block.parentSlot);
  assert.ok(Number.isSafeInteger(parent));
  const time = block.blockTime === null ? null : new Date(Number(block.blockTime) * 1000);
  return {
    kind: "header",
    origin: "rpc",
    number: slot,
    hash: block.blockhash,
    parent_hash: block.previousBlockhash,
    parent_number: parent,
    timestamp: time === null ? null : time.toISOString(),
  };
}

/** Waits until `intervalMs` has passed since it last let a call go: the RPC refuses bursts. */
export function pacer(intervalMs: number) {
  assert.ok(Number.isInteger(intervalMs) && intervalMs >= 0);
  let last = -Infinity;
  return async () => {
    const wait = last + intervalMs - performance.now();
    if (wait > 0) await sleep(wait);
    last = performance.now();
  };
}

/** A midnight's records: where it falls, and the four headers its day boundary is checked with. */
export function boundaryRecords(
  midnight: string,
  block: number,
  headers: readonly Header[],
): RawRecord[] {
  assert.equal(headers.length, 4, "both origins state both headers");
  assert.ok(headers.some((header) => header.origin === "portal" && header.number === block));
  return [
    { id: `boundary:${midnight}`, callId: midnight, data: { kind: "boundary", midnight, block } },
    ...headers.map((header) => ({
      id: `${header.origin}:${header.number}`,
      callId: midnight,
      data: header,
    })),
  ];
}
