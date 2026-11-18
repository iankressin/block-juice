import * as z from "zod";
import { observedFetch, observeDelay } from "#src/transport-metrics.ts";
import { retryAfterMs, systemClock, type Clock } from "#src/clock.ts";
import { LighterError, withRetries } from "#src/lighter/retry.ts";

// The API's hosts, limits and replies, each checked on real calls: catalog/vendors/lighter/.
// A standard caller gets 60 requests a minute per IP. Past that Lighter answers 429 or 405 and blocks for 60 s.
export const lighterEnv = z.object({
  LIGHTER_API_URL: z.url().default("https://mainnet.zklighter.elliot.ai"),
  LIGHTER_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().max(60).default(15),
});

export type LighterEnv = z.infer<typeof lighterEnv>;

const TIMEOUT_MS = 60_000;

// Lighter's error replies and its 200 replies both carry `code` and `message`.
const errorBody = z.object({ code: z.number().optional(), message: z.string().optional() });
const envelope = z.looseObject({ code: z.unknown().optional(), message: z.unknown().optional() });

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
  const { status } = response;
  return new LighterError(
    `Lighter answered HTTP ${status}${detail}: ${message ?? text.slice(0, 200)}`,
    status === 429 || status === 405 || status >= 500,
    { status, code, retryAfterMs: retryAfterMs(response.headers.get("retry-after"), nowMs) },
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
  /** One GET. Resolves with the body, checked against `schema`, once Lighter's `code` is 200. */
  get<T extends z.ZodType>(path: string, query: Record<string, string | number | boolean>, schema: T): Promise<z.output<T>>;
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

  // A request that gets 429, 405 or a 5xx waits and tries again (see retry.ts), and so does one that
  // loses its connection or times out.
  function send(request: URL): Promise<unknown> {
    return withRetries(request.pathname, clock, async () => {
      // Each attempt waits its turn, so a retry counts against the rate too.
      const waitMs = lastStartAt + spacingMs - clock.now();
      if (waitMs > 0) await observeDelay(() => clock.sleep(waitMs));
      lastStartAt = clock.now();
      const response = await observedFetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw await lighterError(response, clock.now());
      const body: unknown = await response.json();
      const checked = envelope.safeParse(body);
      if (!checked.success) {
        throw new LighterError(`Lighter answered ${request.pathname} with a body that is not a JSON object`, false, {
          status: response.status,
        });
      }
      const { code, message } = checked.data;
      if (code !== 200) {
        throw new LighterError(`Lighter answered code ${String(code)}: ${String(message ?? "")}`, false, {
          status: response.status,
          code: typeof code === "number" ? code : undefined,
        });
      }
      return body;
    });
  }

  function get<T extends z.ZodType>(
    path: string,
    query: Record<string, string | number | boolean>,
    schema: T,
  ): Promise<z.output<T>> {
    const request = new URL(path, env.LIGHTER_API_URL);
    for (const [key, value] of Object.entries(query)) request.searchParams.set(key, String(value));
    // One request at a time: each call joins the queue behind the last. The shape check runs after
    // the retries, so a reply in the wrong shape is not asked for again.
    const result = queue.then(async () => {
      const parsed = schema.safeParse(await send(request));
      if (!parsed.success) {
        throw new Error(`Lighter sent ${path} in an unexpected shape:\n${z.prettifyError(parsed.error)}`);
      }
      return parsed.data;
    });
    queue = result.catch(() => undefined);
    return result;
  }

  async function markets() {
    const reply = await get("/api/v1/orderBookDetails", {}, detailsReply);
    return [...reply.order_book_details, ...reply.spot_order_book_details];
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
