import { setTimeout } from "node:timers/promises";
import { describeError, logger, observedFetch, observeDelay } from "@ingestion/lib";
import * as z from "zod";

/** Time as the client sees it, so a test can pass a wait at once. */
export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = { now: () => Date.now(), sleep: (ms) => setTimeout(ms) };

// The API's hosts, limits and replies, each checked on real calls: catalog/vendors/lighter/.
// A standard caller gets 60 requests a minute per IP. Past that Lighter answers 429 or 405 and blocks for 60 s.
export const lighterEnv = z.object({
  LIGHTER_API_URL: z.url().default("https://mainnet.zklighter.elliot.ai"),
  LIGHTER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().max(60).default(15),
});

export type LighterEnv = z.infer<typeof lighterEnv>;

// A request that gets 429, 405 or a 5xx waits and tries again, and so does one that loses its connection
// or times out. The last wait spans Lighter's 60 s block.
const RETRY_WAITS_MS = [2_000, 10_000, 60_000];
const TIMEOUT_MS = 60_000;
/** The longest a `Retry-After` can make a retry wait. */
export const RETRY_AFTER_CAP_MS = 120_000;

/** A `Retry-After` header as ms to wait: seconds, or an HTTP date taken against `nowMs`. Undefined when absent or invalid. */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  const text = header?.trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  // Date.parse reads "-3" as a year, so only text that names a month can be a date.
  if (!/[a-z]/i.test(text)) return undefined;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

const errorBody = z.object({ code: z.number().optional(), message: z.string().optional() });

export class LighterError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, code?: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    if (code !== undefined) this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  get retryable() {
    return this.status === 429 || this.status === 405 || this.status >= 500;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function lighterError(response: Response, nowMs: number): Promise<LighterError> {
  // The status is known, so a body that fails to read must not turn this into a network error.
  const text = await response.text().catch(() => "");
  const body = errorBody.safeParse(parseJson(text));
  const { code, message } = body.success ? body.data : {};
  const detail = code === undefined ? "" : ` (code ${code})`;
  return new LighterError(
    response.status,
    `Lighter answered HTTP ${response.status}${detail}: ${message ?? text.slice(0, 200)}`,
    code,
    retryAfterMs(response.headers.get("retry-after"), nowMs),
  );
}

/** One orderBookDetails entry; every other field stays. */
const marketEntry = z.looseObject({
  market_id: z.number(),
  symbol: z.string(),
  market_type: z.enum(["perp", "spot"]),
  size_decimals: z.number(),
  price_decimals: z.number(),
});

export type LighterMarket = z.output<typeof marketEntry>;

const detailsReply = z.object({
  order_book_details: z.array(marketEntry),
  spot_order_book_details: z.array(marketEntry),
});

export type LighterClient = {
  /** One GET. Resolves with the body once Lighter's `code` is 200. */
  get(path: string, query?: Record<string, string | number | boolean>): Promise<Record<string, unknown>>;
  /** Every market, perps then spots. */
  markets(): Promise<LighterMarket[]>;
  /** The market for each symbol, once each and in first-seen order. Throws on an unknown symbol. */
  resolveMarkets(symbols: readonly string[]): Promise<LighterMarket[]>;
};

/** Calls Lighter's exchange API one request at a time, each starting a minute-share after the last. */
export function createLighterClient(env: LighterEnv, clock: Clock = systemClock): LighterClient {
  const spacingMs = 60_000 / env.LIGHTER_REQUESTS_PER_MINUTE;
  let lastStartAt = -Infinity;
  let queue: Promise<unknown> = Promise.resolve();

  async function send(request: URL): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      const waitMs = lastStartAt + spacingMs - clock.now();
      if (waitMs > 0) await observeDelay(() => clock.sleep(waitMs));
      lastStartAt = clock.now();
      let error: Error;
      try {
        const response = await observedFetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) throw await lighterError(response, clock.now());
        const body = (await response.json()) as Record<string, unknown>;
        if (body.code !== 200) {
          throw new LighterError(
            response.status,
            `Lighter answered code ${String(body.code)}: ${String(body.message ?? "")}`,
            typeof body.code === "number" ? body.code : undefined,
          );
        }
        return body;
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause));
      }
      const scheduledWaitMs = RETRY_WAITS_MS[attempt];
      if ((error instanceof LighterError && !error.retryable) || scheduledWaitMs === undefined) throw error;
      const asked = error instanceof LighterError ? error.retryAfterMs : undefined;
      const retryWaitMs = asked === undefined ? scheduledWaitMs : Math.min(asked, RETRY_AFTER_CAP_MS);
      logger.info(
        { path: request.pathname, error: describeError(error), waitMs: retryWaitMs },
        "Lighter failed a request, waiting before trying again",
      );
      await observeDelay(() => clock.sleep(retryWaitMs));
    }
  }

  function get(path: string, query: Record<string, string | number | boolean> = {}) {
    const request = new URL(path, env.LIGHTER_API_URL);
    for (const [key, value] of Object.entries(query)) request.searchParams.set(key, String(value));
    // One request at a time: each call joins the queue behind the last.
    const result = queue.then(() => send(request));
    queue = result.catch(() => undefined);
    return result;
  }

  async function markets() {
    const parsed = detailsReply.safeParse(await get("/api/v1/orderBookDetails"));
    if (!parsed.success) {
      throw new Error(`Lighter sent orderBookDetails in an unexpected shape:\n${z.prettifyError(parsed.error)}`);
    }
    return [...parsed.data.order_book_details, ...parsed.data.spot_order_book_details];
  }

  return {
    get,
    markets,
    async resolveMarkets(symbols) {
      const all = await markets();
      return [...new Set(symbols)].map((symbol) => {
        const named = all.filter((m) => m.symbol === symbol);
        if (named.length === 0) throw new Error(`Lighter lists no market with the symbol ${symbol}`);
        if (named.length === 1) return named[0]!;
        // A symbol can name several markets: Lighter reuses it once a market goes dead.
        const active = named.filter((m) => m.status === "active");
        if (active.length !== 1) {
          const ids = named.map((m) => `${m.market_id} (${m.status})`).join(", ");
          throw new Error(`Lighter lists ${named.length} markets with the symbol ${symbol} and ${active.length} are active: ${ids}`);
        }
        return active[0]!;
      });
    },
  };
}
