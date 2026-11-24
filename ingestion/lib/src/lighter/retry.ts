import type { Clock } from "#src/clock.ts";
import { describeError } from "#src/calls.ts";
import { logger } from "#src/logger.ts";
import { observeDelay } from "#src/transport-metrics.ts";

// The waits before each retry of a request that can pass on a retry. The last wait spans Lighter's 60 s block.
export const RETRY_WAITS_MS = [2_000, 10_000, 60_000];
/** The longest a `Retry-After` can make a retry wait. */
export const RETRY_AFTER_CAP_MS = 120_000;

type LighterErrorOptions = { status?: number; code?: number; retryAfterMs?: number };

/** A failure that already knows whether a retry can help, and what `Retry-After` asked. */
export class LighterError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly code?: number;
  readonly retryAfterMs?: number;

  constructor(message: string, retryable: boolean, { status, code, retryAfterMs }: LighterErrorOptions = {}) {
    super(message);
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** A transport failure: undici's TypeError ("fetch failed", "terminated") or an abort from the deadline. A local error, such as a full disk, is not. */
function isTransportFailure(error: Error): boolean {
  return error instanceof TypeError || error.name === "TimeoutError" || error.name === "AbortError";
}

/**
 * Runs `attempt` again after a retryable failure, waiting as `RETRY_WAITS_MS` says, then throws the last failure.
 * Only a retryable LighterError or a transport failure is retried. A failure that is not a LighterError is thrown with `what` in its message.
 */
export async function withRetries<T>(what: string, clock: Clock, attempt: () => Promise<T>): Promise<T> {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const scheduledMs = RETRY_WAITS_MS[n];
      const retryable = error instanceof LighterError ? error.retryable : isTransportFailure(error);
      if (!retryable || scheduledMs === undefined) {
        throw error instanceof LighterError ? error : new Error(`Lighter ${what}: ${describeError(error)}`, { cause: error });
      }
      const asked = error instanceof LighterError ? error.retryAfterMs : undefined;
      const waitMs = asked === undefined ? scheduledMs : Math.min(asked, RETRY_AFTER_CAP_MS);
      logger.info({ what, error: describeError(error), waitMs }, "Lighter failed a request, waiting before trying again");
      await observeDelay(() => clock.sleep(waitMs));
    }
  }
}
