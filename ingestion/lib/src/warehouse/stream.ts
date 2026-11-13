import type { PortalBatch, Target, TargetState } from "@subsquid/pipes";
import { drizzleTarget, type Transaction } from "@subsquid/pipes/targets/drizzle/node-postgres";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Batch, StreamRecords } from "#src/source.ts";
import type { Query } from "#src/warehouse/index.ts";
import { recordCoverage, type StreamProvenance } from "#src/warehouse/provenance.ts";

export type PipesTargetOptions = {
  /**
   * Blocks one run reads before it stops, on the batch that passes the cap.
   * Unset means no cap: the source stream runs on to its own end.
   */
  maxBlocks?: number;
  provenance?: StreamProvenance;
  cursorId?: string;
  /** Called only after rows and cursor commit; seconds includes commit/lock/retry overhead. */
  onLoad(load: { records: number; seconds: number; writeSeconds: number; committedBlock: number }): void | Promise<void>;
};

/**
 * Pipes' own Postgres target, with the warehouse writing the rows. Pipes keeps the cursor in
 * <schema>._sync, keyed by the source table and configuration generation, and wraps each batch
 * in one transaction; `write`
 * runs the warehouse's statements inside it. Rows and cursor commit together, and the next
 * run resumes after the last block that committed.
 *
 * It reads finalized blocks only. No fork can reach it, so it gives Pipes no tables to track
 * for rollback, and Pipes adds no triggers or snapshot tables to the raw tables.
 */
export function pipesTarget({
  db,
  schema,
  id,
  write,
  maxBlocks,
  onLoad,
  provenance,
  cursorId,
}: PipesTargetOptions & {
  db: NodePgDatabase;
  schema: string;
  id: string;
  write(q: Query, batch: Batch): Promise<void>;
}): Target<StreamRecords> {
  let written = { records: 0, writeSeconds: 0 };
  let ranges: [number, number, boolean][] = [];
  const pipes = drizzleTarget<StreamRecords>({
    db,
    tables: [],
    settings: { state: { schema, table: "_sync", id: cursorId ?? id } },
    onData: async ({ tx, data }) => {
      const records = Array.isArray(data) ? data : Object.values(data).flat();
      const startedAt = performance.now();
      try {
        await write(within(tx), { records, failed: [] });
        if (provenance) {
          for (const range of ranges) {
            await recordCoverage(within(tx), `"${schema}"`, id, provenance, ...range);
          }
        }
        written.records = records.length;
      } finally {
        written.writeSeconds += (performance.now() - startedAt) / 1000;
      }
    },
  });
  async function* committed(batches: AsyncIterable<PortalBatch<StreamRecords>>) {
    for await (const batch of batches) {
      const startedAt = performance.now();
      written = { records: 0, writeSeconds: 0 };
      yield batch;
      // Pipes requests the next batch only after its transaction resolves. On failure
      // it closes this generator instead, so no uncommitted progress is published.
      await onLoad({ ...written, seconds: (performance.now() - startedAt) / 1000,
        committedBlock: batch.ctx.stream.state.current.number });
    }
  }

  return {
    ...pipes,
    requiresFinalizedStream: true,
    write: (writer) =>
      pipes.write({
        ...writer,
        read: (state, options) => {
          const batches = trackRanges(writer.read(state, options), state, (value) => { ranges = value; });
          // No cap: leave Pipes' own read loop in place. It ends when the source stream ends,
          // at END_BLOCK or the finalized head, and each batch still commits and reports.
          const limited = maxBlocks === undefined ? batches : upTo(maxBlocks, state, batches);
          return committed(limited);
        },
      }),
  };
}

/** The target asks for the next batch only after committing the previous one. Retries reuse its range. */
async function* trackRanges<T>(
  batches: AsyncIterable<PortalBatch<T>>, state: TargetState | undefined,
  setRanges: (ranges: [number, number, boolean][]) => void,
) {
  let previous = state?.latest.number;
  for await (const batch of batches) {
    const { initial, current, ranges } = batch.ctx.stream.state;
    const first = previous === undefined ? initial : previous + 1;
    const confirmed: [number, number, boolean][] = [];
    for (const range of [...ranges].sort((a, b) => a.from - b.from)) {
      const begin = Math.max(first, range.from);
      const end = Math.min(current.number, range.to ?? Infinity);
      if (begin > end) continue;
      const last = confirmed.at(-1);
      if (last && begin <= last[1] + 1) last[1] = Math.max(last[1], end);
      else confirmed.push([begin, end, previous === undefined]);
    }
    setRanges(confirmed);
    yield batch;
    previous = current.number;
  }
}

/** The warehouse's statements, run in a Pipes transaction. Each `$n` becomes a bound value; `sql.param` keeps an array one value. */
const within = (tx: Transaction): Query => ({
  async query<R>(text: string, params: unknown[] = []) {
    const parts = text.split(/\$(\d+)/);
    const query = sql.join(parts.map((part, i) => (i % 2 ? sql.param(params[Number(part) - 1]) : sql.raw(part))));
    const { rows } = await tx.execute(query);
    return { rows: rows as R[] };
  },
});

/** Passes batches on until the run has read `maxBlocks` blocks, then ends the stream. */
async function* upTo<T>(maxBlocks: number, state: TargetState | undefined, batches: AsyncIterable<PortalBatch<T>>) {
  for await (const batch of batches) {
    yield batch;
    const { initial, current } = batch.ctx.stream.state;
    const start = state ? state.latest.number + 1 : initial;
    if (current.number - start + 1 >= maxBlocks) return;
  }
}
