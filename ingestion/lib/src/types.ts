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

export type DeadLetter = {
  id: string;
  call: unknown;
  error: string;
  attempts: number;
};

/**
 * `name` and `table` must match the dbt source name and table name.
 * Dagster uses the pair as the asset key, which links each ingestion
 * asset to the dbt models that read from it.
 *
 * `retry` holds the calls that failed in earlier runs, parsed with `call`. A source makes
 * them again next to its new calls. A failed call's `id` is the `callId` of the record it
 * would have produced, which is how a success clears its dead letter. A dead letter whose
 * call no longer parses is parked.
 */
export interface Source<E, C> {
  name: string;
  table: string;
  env: z.ZodType<E>;
  call: z.ZodType<C>;
  extract(env: E, retry: C[]): AsyncIterable<Batch<C>>;
}

export interface Target {
  open(table: string): Promise<TargetTable>;
}

/** `write` must be an upsert on `id`, so a rerun over the same blocks leaves the same rows. */
export interface TargetTable {
  name: string;
  write(records: RawRecord[]): Promise<void>;
  close(): Promise<void>;
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

export interface DeadLetterQueue {
  open(table: string): Promise<DeadLetterTable>;
}

export interface DeadLetterTable {
  name: string;
  /** Dead letters that have not yet failed `maxAttempts` times. */
  pending(): Promise<DeadLetter[]>;
  push(failed: Failed[]): Promise<void>;
  /** Parks these dead letters at once, each with the error that says why. */
  park(letters: Pick<DeadLetter, "id" | "error">[]): Promise<void>;
  resolve(ids: string[]): Promise<void>;
  backlog(): Promise<DeadLetterBacklog>;
  close(): Promise<void>;
}
