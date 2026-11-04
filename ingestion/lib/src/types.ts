import type { PortalStream } from "@subsquid/pipes";
import type * as z from "zod";

export type RawRecord = {
  /** The row's key. It can add what only the reply knows, such as the slot a Solana read landed on. */
  id: string;
  /** The id of the call this record answers. A success clears the dead letter with this id. */
  callId: string;
  data: Record<string, unknown>;
};

/** A call that failed after the transport's own retries. `call` holds what is needed to make it again. */
export type Failed<C = unknown> = {
  id: string;
  call: C;
  error: string;
};

export type Batch<C = unknown> = {
  records: RawRecord[];
  failed: Failed<C>[];
};

/** What a stream source's outputs must be: records, or named lists of them that load together. */
export type StreamRecords = RawRecord[] | Record<string, RawRecord[]>;

/**
 * `name` and `table` must match the dbt source name and table name.
 * Dagster uses the pair as the asset key, which links each ingestion
 * asset to the dbt models that read from it.
 */
interface SourceBase<E> {
  name: string;
  table: string;
  env: z.ZodType<E>;
}

/**
 * A source that makes calls, such as RPC reads at one block.
 *
 * `retry` holds the calls that failed in earlier runs, parsed with `call`. A source makes
 * them again next to its new calls. A failed call's `id` is the `callId` of the record it
 * would have produced, which is how a success clears its dead letter. A dead letter whose
 * call no longer parses is parked.
 */
export interface Source<E, C> extends SourceBase<E> {
  call: z.ZodType<C>;
  extract(env: E, retry: C[]): AsyncIterable<Batch<C>>;
}

/**
 * A source that reads blocks through a Pipes stream. runSource pipes it into the warehouse,
 * where Pipes keeps its cursor, so each run resumes after the last block the one before loaded.
 * The stream must end: give its range a `to`, such as Portal's finalized head at the start.
 */
export interface StreamSource<E> extends SourceBase<E> {
  /** About this many blocks a run (it ends on the batch that passes it), so a long backfill spreads over several runs. 1,000,000 by default. */
  maxBlocksPerRun?: number;
  stream(env: E): Promise<PortalStream<any, StreamRecords>>;
}

/**
 * Pending dead letters are retried next run. Parked ones failed too often, or no longer match
 * the source's call schema, and wait for a person.
 */
export type DeadLetterBacklog = {
  pending: number;
  parked: number;
};

/** What runSource reports when a run ends, to the Pushgateway and to ops.ingestion_runs. */
export type RunReport = {
  runId: string;
  /** Set when Dagster started the run. */
  dagsterRunId: string | undefined;
  source: string;
  table: string;
  startedAt: Date;
  finishedAt: Date;
  /** Undefined when the run succeeded. */
  error: string | undefined;
  retriedCalls: number;
  recordsWritten: number;
  failedCalls: number;
  /** Time spent writing records and dead letters to the warehouse. The rest went to extraction. */
  loadSeconds: number;
  /** Undefined when the run failed before it counted its dead letters. */
  backlog: DeadLetterBacklog | undefined;
};
