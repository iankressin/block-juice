import { setTimeout } from "node:timers/promises";
import { describeError, logger } from "@ingestion/lib";
import * as z from "zod";

/** Time as the client sees it, so a test can pass a retry's wait at once. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => setTimeout(ms) };

// The API's endpoints, limits and fields, each checked on real replies: catalog/vendors/polymarket/.
// Gamma allows 300 requests per 10 seconds on /markets. A request that gets 429 or a 5xx waits
// and tries again, and so does a request that loses its connection or times out.
const RETRY_WAITS_MS = [1000, 2000, 4000];
const TIMEOUT_MS = 60_000;

// Only what the walk needs. A market keeps every other field it came with.
const reply = z.object({
  markets: z.array(z.looseObject({ id: z.string() })),
  next_cursor: z.string().nullish(),
});

export type Market = z.output<typeof reply>["markets"][number];

export type MarketsPage = { markets: Market[]; nextCursor: string | undefined };

export type MarketsQuery = {
  version: "v1" | "v2";
  closed: boolean;
  endDateMin: string | null;
  endDateMax: string | null;
  limit: number;
  afterCursor: string | undefined;
};

const errorBody = z.object({ error: z.string() });

export class GammaError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }

  get retryable() {
    return this.status === 429 || this.status >= 500;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function gammaError(response: Response): Promise<GammaError> {
  const text = await response.text();
  const body = errorBody.safeParse(parseJson(text));
  return new GammaError(
    response.status,
    `Gamma answered HTTP ${response.status}: ${body.success ? body.data.error : text.slice(0, 200)}`,
  );
}

export type GammaClient = ReturnType<typeof createGammaClient>;

/** Reads Gamma's market list at `url`. */
export function createGammaClient(url: string, clock: Clock) {
  async function get(path: string, query: Record<string, string>): Promise<unknown> {
    const request = new URL(path, url);
    for (const [key, value] of Object.entries(query)) request.searchParams.set(key, value);
    for (let attempt = 0; ; attempt++) {
      let error: Error;
      try {
        const response = await fetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (response.ok) return await response.json();
        error = await gammaError(response);
      } catch (cause) {
        // A reset connection, a timeout or a body cut short. A walk lasts many minutes, so these retry too.
        error = cause instanceof Error ? cause : new Error(String(cause));
      }
      const waitMs = RETRY_WAITS_MS[attempt];
      if ((error instanceof GammaError && !error.retryable) || waitMs === undefined) throw error;
      logger.info({ path, error: describeError(error), waitMs }, "Gamma failed a request, waiting before trying again");
      await clock.sleep(waitMs);
    }
  }

  return {
    /** One page of the keyset list. `nextCursor` is undefined on the last page. */
    async markets(query: MarketsQuery): Promise<MarketsPage> {
      const params: Record<string, string> = {
        version: query.version,
        closed: String(query.closed),
        limit: String(query.limit),
      };
      if (query.endDateMin !== null) params.end_date_min = query.endDateMin;
      if (query.endDateMax !== null) params.end_date_max = query.endDateMax;
      if (query.afterCursor !== undefined) params.after_cursor = query.afterCursor;
      const parsed = reply.safeParse(await get("/markets/keyset", params));
      if (!parsed.success) {
        throw new Error(`Gamma sent markets in an unexpected shape:\n${z.prettifyError(parsed.error)}`);
      }
      return { markets: parsed.data.markets, nextCursor: parsed.data.next_cursor || undefined };
    },
  };
}
