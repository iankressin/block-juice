import { describeError, logger, observedFetch, observeDelay } from "@ingestion/lib";
import * as z from "zod";
import { RETRY_AFTER_CAP_MS, retryAfterMs, systemClock, type Clock } from "#src/lighter/client.ts";

// The Explorer's host, limits and replies, each checked on real calls: catalog/vendors/lighter/.
// It allows 45 weight a minute per IP; a path costs 1 unless noted at its method.
export const lighterExplorerEnv = z.object({
  LIGHTER_EXPLORER_URL: z.url().default("https://explorer.elliot.ai"),
  LIGHTER_EXPLORER_WEIGHT_PER_MINUTE: z.coerce.number().int().positive().max(45).default(15),
});

export type LighterExplorerEnv = z.infer<typeof lighterExplorerEnv>;

/** The docs' PubDataType enum but Empty and Trade, in the docs' order. Plan 1 loads plain trades from S3. */
export const LEDGER_TYPES: readonly string[] = [
  "L1Deposit", "L1CreateMarket", "L1UpdateMarket", "L2CreateSubAccount", "L2CreatePublicPool",
  "L2UpdatePublicPool", "L2MintShares", "L2UpdateLeverage", "L2UpdateMargin", "L2Transfer", "Withdraw",
  "TradeWithFunding", "LiquidationTrade", "LiquidationTradeWithFunding", "BurnedShares", "ExitPosition",
  "ExitPositionWithFunding", "Deleverage", "DeleverageWithFunding", "L1RegisterAsset", "L1UpdateAsset",
  "L1CreateSpotMarket", "L1UpdateSpotMarket", "WithdrawV2", "L1CreateMarketV2", "L1DepositV2",
  "L1UpdateMarketV2", "L2TransferV2", "L2CreateStakingPool", "L2UpdateStakingPool", "L2StakeAssets",
  "UnstakeAssets", "L1SetSystemConfig", "ExecutedPendingUnlock", "L2UpdateAccountConfig",
  "L2UpdateMarketConfig", "InternalLiquidateSpot", "L2UpdateAssetConfig", "L2UpdateAccountAssetConfig",
];

/** The types whose entry moves money, margin, shares or a position: each gets a `logs/{hash}` lookup for its block. */
export const DETAIL_TYPES: readonly string[] = [
  "L1Deposit", "L1DepositV2", "Withdraw", "WithdrawV2", "L2Transfer", "L2TransferV2", "L2UpdateMargin",
  "L2MintShares", "BurnedShares", "L2StakeAssets", "UnstakeAssets", "ExecutedPendingUnlock", "ExitPosition",
  "ExitPositionWithFunding",
];

export type ExplorerLog = {
  hash: string;
  time: string;
  tx_type: string;
  pubdata_type: string;
  status: string | null;
  pubdata: Record<string, unknown>;
} & Record<string, unknown>;

// As Lighter's exchange client: a 429, 405, 5xx, lost connection or timeout waits and tries again.
const RETRY_WAITS_MS = [2_000, 10_000, 60_000];
const TIMEOUT_MS = 60_000;

export class ExplorerError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }

  get retryable() {
    return this.status === 429 || this.status === 405 || this.status >= 500;
  }
}

const errorBody = z.object({ error: z.string().optional() });

async function explorerError(response: Response, path: string, nowMs: number): Promise<ExplorerError> {
  // The status is known, so a body that fails to read must not turn this into a network error.
  const text = await response.text().catch(() => "");
  let message: string | undefined;
  try {
    message = errorBody.parse(JSON.parse(text)).error;
  } catch {
    // Not the Explorer's `{"error"}` shape: quote the text.
  }
  return new ExplorerError(
    response.status,
    `Lighter's Explorer answered HTTP ${response.status} for ${path}:${message ?? text.slice(0, 200)}`,
    retryAfterMs(response.headers.get("retry-after"), nowMs),
  );
}

export type ExplorerClient = {
  /** One GET. `weight` is what Lighter charges for the path. Resolves with the parsed body. */
  get(path: string, query?: Record<string, string | number>, weight?: number): Promise<unknown>;
  /** The 20 most recently updated batches, weight 1. */
  recentBatches(): Promise<Record<string, unknown>[]>;
  /** One batch with its blocks and status changes, weight 1. Undefined when the Explorer holds no such batch. */
  batch(batchNumber: number): Promise<Record<string, unknown> | undefined>;
  /** One page of an account's ledger entries, newest first, weight 4. Never plain trades. */
  accountLogs(accountIndex: number, page: { limit: number; offset: number }): Promise<ExplorerLog[]>;
  /** One entry with its `block_number` and `batch_number`, weight 1. */
  log(hash: string): Promise<Record<string, unknown>>;
  /** Transactions per hour, weight 1. */
  txStats(): Promise<Record<string, unknown>>;
};

function expectArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Lighter's Explorer sent ${what} in an unexpected shape: not an array`);
  return value as T[];
}

/** Calls Lighter's Explorer one request at a time, each starting after the last one's share of the weight budget. */
export function createExplorerClient(env: LighterExplorerEnv, clock: Clock = systemClock): ExplorerClient {
  const msPerWeight = 60_000 / env.LIGHTER_EXPLORER_WEIGHT_PER_MINUTE;
  let lastStartAt = -Infinity;
  let lastWeight = 0;
  let queue: Promise<unknown> = Promise.resolve();

  async function send(request: URL, weight: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const waitMs = lastStartAt + lastWeight * msPerWeight - clock.now();
      if (waitMs > 0) await observeDelay(() => clock.sleep(waitMs));
      lastStartAt = clock.now();
      lastWeight = weight;
      let error: Error;
      try {
        const response = await observedFetch(request, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok) throw await explorerError(response, request.pathname, clock.now());
        return await response.json();
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause));
      }
      const scheduledWaitMs = RETRY_WAITS_MS[attempt];
      if ((error instanceof ExplorerError && !error.retryable) || scheduledWaitMs === undefined) throw error;
      const asked = error instanceof ExplorerError ? error.retryAfterMs : undefined;
      const retryWaitMs = asked === undefined ? scheduledWaitMs : Math.min(asked, RETRY_AFTER_CAP_MS);
      logger.info(
        { path: request.pathname, error: describeError(error), waitMs: retryWaitMs },
        "Lighter's Explorer failed a request, waiting before trying again",
      );
      await observeDelay(() => clock.sleep(retryWaitMs));
    }
  }

  function get(path: string, query: Record<string, string | number> = {}, weight = 1) {
    const request = new URL(path, env.LIGHTER_EXPLORER_URL);
    for (const [key, value] of Object.entries(query)) request.searchParams.set(key, String(value));
    // One request at a time: each call joins the queue behind the last.
    const result = queue.then(() => send(request, weight));
    queue = result.catch(() => undefined);
    return result;
  }

  return {
    get,
    async recentBatches() {
      return expectArray(await get("/api/batches"), "/batches");
    },
    async batch(batchNumber) {
      try {
        return (await get(`/api/batches/${batchNumber}`)) as Record<string, unknown>;
      } catch (error) {
        if (error instanceof ExplorerError && error.status === 404) return undefined;
        throw error;
      }
    },
    async accountLogs(accountIndex, { limit, offset }) {
      // Several types go in one comma-separated value: a repeated parameter keeps only the first.
      const query = { pub_data_type: LEDGER_TYPES.join(","), limit, offset };
      return expectArray(await get(`/api/accounts/${accountIndex}/logs`, query, 4), "an account's logs");
    },
    async log(hash) {
      return (await get(`/api/logs/${encodeURIComponent(hash)}`)) as Record<string, unknown>;
    },
    async txStats() {
      return (await get("/api/stats/tx", { aggregation_period: "1h" })) as Record<string, unknown>;
    },
  };
}
