import { describeError, readJson, uniqueBy, systemClock, type Batch, type RawRecord, type Source, type Clock } from "@ingestion/lib";
import {
  createLighterClient,
  lighterEnv,
  type LighterClient,
  type LighterEnv,
} from "@ingestion/lib/lighter";
import * as z from "zod";

const DAY_MS = 86_400_000;

// Kinds that return one daily series for each market when asked with filter=byMarket.
export const MARKET_KINDS = [
  "volume",
  "maker_fee",
  "taker_fee",
  "liquidation_fee",
  "trade_count",
  "liquidation_count",
  "liquidation_volume",
  "open_interest",
  "attribution_maker_fee",
  "attribution_taker_fee",
] as const;

// Kinds that return the exchange-wide series whatever the filter. buyback starts on 2025-12-30.
const WIDE_KINDS = [
  "account_count",
  "active_account_count",
  "inflow",
  "outflow",
  "transfer_fee",
  "withdraw_fee",
  "buyback",
  "buyback_usdc",
] as const;

// Every daily kind. tps is left out: it is a live five-minute series, not a daily one.
export const EXCHANGE_KINDS = [...MARKET_KINDS, ...WIDE_KINDS] as const;

const kindSchema = z.enum(EXCHANGE_KINDS);
type Kind = z.infer<typeof kindSchema>;

const callSchema = z.object({ kind: kindSchema, market: z.string().nullable() });
export type MetricCall = z.infer<typeof callSchema>;

const callId = (call: MetricCall) => `${call.kind}:${call.market ?? "all"}`;

const marketsFile = z.object({ markets: z.array(z.string().min(1)) });

function parseMarkets(json: unknown): string[] {
  const parsed = marketsFile.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid markets.json:\n${z.prettifyError(parsed.error)}`);
  return [...new Set(parsed.data.markets)];
}

const metricsReply = z.object({ metrics: z.array(z.looseObject({ timestamp: z.number() })) });

/**
 * Reads one kind's whole daily series. A point counts only when its UTC day had ended by the time
 * the request went out, so today's partial point waits for the next run.
 */
async function fetchSeries(lighter: LighterClient, call: MetricCall, clock: Clock): Promise<RawRecord[]> {
  const cutoff = clock.now();
  const query: Record<string, string> = { period: "all", kind: call.kind };
  if (call.market !== null) Object.assign(query, { filter: "byMarket", value: call.market });
  const reply = metricsReply.parse(await lighter.get("/api/v1/exchangeMetrics", query));
  return reply.metrics
    .filter((point) => point.timestamp * 1000 + DAY_MS <= cutoff)
    .map((point) => ({
      id: `${callId(call)}:${point.timestamp}`,
      callId: callId(call),
      data: { kind: call.kind, market: call.market, point },
    }));
}

// Every run reads every call again, because each reply is the whole daily series. Each exchange-wide
// kind is read once, and each market kind once for each symbol in markets.json, which may list none.
// A retried call that the run makes anyway runs once. One request runs at a time, one call a batch.
export const exchangeMetricsSource = (clock: Clock = systemClock): Source<LighterEnv, MetricCall> => ({
  name: "lighter",
  table: "exchange_metrics",
  env: lighterEnv,
  call: callSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad markets.json.
    const symbols = parseMarkets(readJson(new URL("../markets.json", import.meta.url)));
    const lighter = createLighterClient(env, clock);
    // Lighter answers an unknown or mis-cased symbol with a series of zeros, so the exact spelling matters.
    const markets = symbols.length ? await lighter.resolveMarkets(symbols) : [];
    const own: MetricCall[] = [
      ...EXCHANGE_KINDS.map((kind: Kind): MetricCall => ({ kind, market: null })),
      ...markets.flatMap((market) => MARKET_KINDS.map((kind): MetricCall => ({ kind, market: market.symbol }))),
    ];

    for (const call of uniqueBy([...own, ...retry], callId)) {
      const batch: Batch<MetricCall> = { records: [], failed: [], succeededCallIds: [] };
      try {
        batch.records = await fetchSeries(lighter, call, clock);
        batch.succeededCallIds!.push(callId(call));
      } catch (error) {
        batch.failed.push({ id: callId(call), call, error: describeError(error) });
      }
      yield batch;
    }
  },
});

export const lighterExchangeMetrics = exchangeMetricsSource();
