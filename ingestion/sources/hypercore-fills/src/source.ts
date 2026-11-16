import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { toLower, validateEthAddressList } from "@ingestion/lib/evm";
import { HyperliquidFillsQueryBuilder, hyperliquidFillsPortalStream, type api } from "@subsquid/pipes/hyperliquid";
import type { PortalClientOptions } from "@subsquid/pipes/portal-client";
import * as z from "zod";

const defaultPortalUrl = "https://portal.sqd.dev/datasets/hyperliquid-fills";

const env = z.object({
  PORTAL_URL: z.url().default(defaultPortalUrl),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type HypercoreFillsEnv = z.infer<typeof env>;

// Every fill field, so each raw row holds the whole fill. Typed over the SDK's FillFields, a field that a
// Pipes upgrade adds fails the typecheck until it is listed here.
const fillFields: { [K in keyof api.FillFields]-?: true } = {
  fillIndex: true,
  user: true,
  coin: true,
  px: true,
  sz: true,
  side: true,
  time: true,
  startPosition: true,
  dir: true,
  closedPnl: true,
  hash: true,
  oid: true,
  crossed: true,
  fee: true,
  builderFee: true,
  tid: true,
  cloid: true,
  feeToken: true,
  builder: true,
  twapId: true,
};

type Block = api.Block<{ block: { number: true; timestamp: true }; fill: typeof fillFields }>;

const tooWide =
  "addresses.json lists no users and no coins. List at least one: HyperCore makes about 1.2M blocks a day, " +
  "and one busy coin fills hundreds of thousands of times a day.";

/** A key of addresses.json as a list. An absent key reads every value; a present one must list some. */
function listed(addresses: Record<string, unknown>, key: "users" | "coins"): string[] | undefined {
  if (!Object.hasOwn(addresses, key)) return undefined;
  const values = addresses[key];
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string" && value !== "")) {
    throw new Error(`addresses.json: ${key} must be a list of non-empty strings`);
  }
  if (values.length === 0) {
    throw new Error(`addresses.json lists no ${key}. List at least one, or remove the key to read every one.`);
  }
  return values;
}

/**
 * The fill request for addresses.json. Portal ANDs the fields of one request, so with both keys it
 * returns the fills of the listed users in the listed coins. Portal returns `user` lowercased, so the
 * users go out lowercased. Coin names are case-sensitive (`BTC`, `@107`, `xyz:TSLA`) and go out as given.
 */
function fillRequest(addresses: Record<string, unknown>): api.FillRequest {
  const users = listed(addresses, "users");
  const coins = listed(addresses, "coins");
  if (users === undefined && coins === undefined) throw new Error(tooWide);
  return {
    ...(users === undefined ? {} : { user: validateEthAddressList(users).map(toLower) }),
    ...(coins === undefined ? {} : { coin: coins }),
  };
}

// Each record is one fill as Pipes returns it, unique by its block and its index in that block.
function blockRecords(block: Block): RawRecord[] {
  const timestamp = new Date(block.header.timestamp).toISOString();
  return block.fills.map((fill) => {
    const id = `${block.header.number}:${fill.fillIndex}`;
    return { id, callId: id, data: { block_number: block.header.number, timestamp, fill } };
  });
}

/**
 * Every HyperCore fill of the users and coins in addresses.json, from START_BLOCK to Portal's finalized
 * head when the run starts. Fields stay as Portal sends them: prices, sizes and fees are JSON numbers,
 * and `side` is `B` or `A`. Pipes drops a field that Portal sends as null, and rejects an id such as
 * `tid` or `oid` past 2^53 rather than load a rounded one.
 */
export const source: StreamSource<HypercoreFillsEnv> = {
  name: "hypercore",
  table: "fills",
  coverage: { defaultPortalUrl, filters: ["users", "coins"], unrestricted: ["users", "coins"] },
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const request = fillRequest(readJson("addresses.json"));
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };
    const query = new HyperliquidFillsQueryBuilder()
      .addFields({ block: { number: true, timestamp: true }, fill: fillFields })
      .addFillRequest({ range, request });

    return hyperliquidFillsPortalStream({
      id: `${this.name}_${this.table}`,
      // Pipes 1.0.0-beta.11 types this as a URL or client options, but PortalStream takes a client
      // as is, and evmPortalStream declares it. The client carries portalClient's retries and headers.
      portal: portal as unknown as PortalClientOptions,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: query.build().pipe((blocks) => blocks.flatMap(blockRecords)),
    });
  },
};
