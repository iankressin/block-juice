import { callBatches, describeError, historyKey, logger, type Batch, type RawRecord, type Source } from "@ingestion/lib";
import {
  createExplorerClient,
  lighterExplorerEnv,
  systemClock,
  type Clock,
  type ExplorerClient,
} from "@ingestion/lib/lighter";
import * as z from "zod";

// Batches before 29654 carry no L1 status and never settle, and 29654 starts at 2025-08-27 12:31:44
// UTC (catalog/vendors/lighter/NOTES.md, L11). A start from the next midnight on begins at 29654 or later.
const EARLIEST_START = "2025-08-28T00:00:00Z";

const startTime = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })], {
    error: (issue) =>
      issue.input === undefined
        ? "Required"
        : "Expected an ISO date or datetime, such as 2026-10-01 or 2026-10-01T00:00:00Z",
  })
  .transform((value) => Date.parse(value))
  .refine((ms) => ms >= Date.parse(EARLIEST_START), {
    message: `START_TIME may not come before ${EARLIEST_START}: batches before 29654 carry no L1 status and never settle (catalog/vendors/lighter/NOTES.md, L11)`,
  });

const batchesEnv = lighterExplorerEnv.extend({ START_TIME: startTime });

export type LighterBatchesEnv = z.infer<typeof batchesEnv>;

const batchCallSchema = z.object({ kind: z.literal("batch"), batch_number: z.number().int().nonnegative() });

type BatchCall = z.infer<typeof batchCallSchema>;

const callId = (call: BatchCall) => `batch:${call.batch_number}`;

// Every 10 batches go out with a checkpoint.
const BATCH_SIZE = 10;

const progress = z.object({ origin: z.number().int().nonnegative(), next: z.number().int().nonnegative() });

const recentBatches = z.array(z.looseObject({ batch_number: z.number().int().nonnegative() })).min(1);

const firstBlock = z.looseObject({ blocks: z.array(z.looseObject({ updated_at: z.string() })).min(1) });

/** An Explorer time in µs since the epoch. Its seconds carry 0 to 6 decimals, and Date.parse keeps 3. */
function microseconds(text: string): number {
  const ms = Date.parse(text);
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(text)?.[1] ?? "";
  if (Number.isNaN(ms) || fraction.length > 6) throw new Error(`Lighter's Explorer sent a time it cannot read: ${text}`);
  return ms * 1000 + Number(fraction.padEnd(6, "0").slice(3));
}

/** The highest batch number in `/batches`, which lists the 20 latest by update time, not by number. */
async function headBatch(explorer: ExplorerClient): Promise<number> {
  const parsed = recentBatches.safeParse(await explorer.recentBatches());
  if (!parsed.success) throw new Error(`Lighter's Explorer sent /batches in an unexpected shape:\n${z.prettifyError(parsed.error)}`);
  return Math.max(...parsed.data.map((batch) => batch.batch_number));
}

/**
 * The highest batch up to `head` whose first block's time is at or before `time` (ms), counting a 404
 * as before; when none is, the first batch that answers. A bisection: about 18 reads for 270,000 batches.
 */
export async function batchHolding(explorer: ExplorerClient, time: number, head: number): Promise<number> {
  // Each batch up to `before` is a 404 or starts at or before `time`; each from `after` on starts after it.
  let before = 0;
  let after = head + 1;
  let beforeAnswered = false;
  while (after - before > 1) {
    const mid = Math.floor((before + after) / 2);
    const reply = await explorer.batch(mid);
    if (reply === undefined) {
      before = mid;
      beforeAnswered = false;
      continue;
    }
    const parsed = firstBlock.safeParse(reply);
    if (!parsed.success) throw new Error(`Lighter's Explorer sent batch ${mid} with no first block time`);
    if (microseconds(parsed.data.blocks[0]!.updated_at) <= time * 1000) {
      before = mid;
      beforeAnswered = true;
    } else {
      after = mid;
    }
  }
  return beforeAnswered ? before : after;
}

const FINAL_STATUSES = new Set(["executed", "nothing_to_execute"]);

/** A batch is final once a status change is `executed` or `nothing_to_execute` (NOTES.md, Batches and L1 settlement). */
export function isFinal(reply: Record<string, unknown>): boolean {
  const changes = reply.status_changes;
  return Array.isArray(changes) && changes.some((change) => FINAL_STATUSES.has(change?.batch_status));
}

async function readBatch(explorer: ExplorerClient, call: BatchCall): Promise<RawRecord> {
  const reply = await explorer.batch(call.batch_number);
  if (reply === undefined) throw new Error(`Lighter's Explorer holds no batch ${call.batch_number}`);
  if (reply.batch_number !== call.batch_number) {
    throw new Error(`Lighter's Explorer answered batch ${call.batch_number} with batch ${String(reply.batch_number)}`);
  }
  return { id: callId(call), callId: callId(call), data: reply };
}

// Reads L1 batches in order from the one holding START_TIME to the head, and keeps each reply whole.
// The checkpoint's `next` is the first batch not yet final, so each run reads committed batches again
// until they settle. A batch that fails, a 404 between origin and the head included, waits as a dead
// letter and does not hold `next` back; retried batches are read after the walk.
export const batchesSource = (clock: Clock = systemClock): Source<LighterBatchesEnv, BatchCall> => ({
  name: "lighter",
  table: "batches",
  env: batchesEnv,
  call: batchCallSchema,
  retryMode: "paged",
  async *extract(env, retry, context) {
    const explorer = createExplorerClient(env, clock);
    const head = await headBatch(explorer);
    const key = historyKey(["lighter", env.LIGHTER_EXPLORER_URL, "batches", env.START_TIME]);
    const saved = progress.safeParse(await context?.getCheckpoint?.(key));
    const origin = saved.success ? saved.data.origin : await batchHolding(explorer, env.START_TIME, head);
    const from = saved.success ? saved.data.next : origin;
    logger.info({ head, origin, from }, "Reading Lighter's batches from the first one not final to the head");

    function* walk(): Generator<BatchCall> {
      for (let n = from; n <= head; n++) yield { kind: "batch", batch_number: n };
    }
    const isFresh = (call: BatchCall) => call.batch_number >= from && call.batch_number <= head;

    // The walk's next batch, and the lowest batch read this run that is not final.
    let walked = from;
    let pending = Infinity;
    for await (const part of callBatches(walk(), retry, callId, isFresh, context, BATCH_SIZE)) {
      const batch: Batch<BatchCall> = { records: [], failed: [] };
      for (const call of part) {
        try {
          const record = await readBatch(explorer, call);
          batch.records.push(record);
          if (!isFinal(record.data)) pending = Math.min(pending, call.batch_number);
        } catch (error) {
          batch.failed.push({ id: callId(call), call, error: describeError(error) });
        }
        if (isFresh(call)) walked = call.batch_number + 1;
      }
      batch.checkpoints = [{ key, value: { origin, next: Math.min(pending, walked) } }];
      yield batch;
    }
  },
});

export const lighterBatches = batchesSource();
