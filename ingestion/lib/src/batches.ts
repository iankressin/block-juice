import { uniqueBy } from "#src/calls.ts";
import type { ExtractionContext } from "#src/source.ts";

/** Consume a producer without retaining its history or eagerly creating all chunks. */
export function* batches<T>(items: Iterable<T>, size = 100): Generator<T[]> {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Batch size must be a positive integer");
  let part: T[] = [];
  for (const item of items) {
    part.push(item);
    if (part.length === size) { yield part; part = []; }
  }
  if (part.length) yield part;
}

export async function* retryPages<C>(retry: C[], context?: ExtractionContext<C>): AsyncGenerator<C[]> {
  if (retry.length) yield retry;
  if (context?.retryPages) yield* context.retryPages;
}

/**
 * Fresh calls must be unique by construction. A cheap membership predicate replaces a set
 * of every generated wallet/token pair. Retry rows are unique in the warehouse; direct
 * callers' duplicate retries are collapsed within each page, as they were before batching.
 */
export async function* callBatches<C>(
  fresh: Iterable<C>, retry: C[], id: (call: C) => string,
  isFresh: (call: C) => boolean, context?: ExtractionContext<C>, size = 100, retryFirst = false,
): AsyncGenerator<C[]> {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Batch size must be a positive integer");
  async function* historical() {
    for await (const page of retryPages(retry, context)) {
      for (const call of uniqueBy(page, id)) if (!isFresh(call)) yield call;
    }
  }
  async function* ordered() {
    if (retryFirst) yield* historical();
    yield* fresh;
    if (!retryFirst) yield* historical();
  }
  let part: C[] = [];
  for await (const call of ordered()) {
    part.push(call);
    if (part.length === size) { yield part; part = []; }
  }
  if (part.length) yield part;
}
