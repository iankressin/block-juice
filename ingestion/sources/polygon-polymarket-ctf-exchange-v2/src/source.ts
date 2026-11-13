import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { address, toLower } from "@ingestion/lib/evm";
import { defineAbi, evmEventDecoder, evmPortalStream, type DecodedEvent, type JsonAbiItem } from "@subsquid/pipes/evm";
import * as z from "zod";
import exchangeAbi from "../../../../catalog/protocols/polymarket/abis/ctf-exchange-v2.json" with { type: "json" };

// The catalog's ABI file is JSON, so its events are typed by name only.
const events = defineAbi(exchangeAbi as readonly JsonAbiItem[]).events;

const env = z.object({
  PORTAL_URL: z.url().default("https://portal.sqd.dev/datasets/polygon-mainnet"),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type ExchangeEnv = z.infer<typeof env>;

const addresses = z.object({
  exchanges: z.array(address).min(1),
  wallets: z.array(address).min(1).optional(),
});

// Each record is one log as Portal returns it, unique by its block and its index in that block. Its event
// is the catalog's key for the ABI event.
function logRecord(event: string, log: DecodedEvent<Record<string, unknown>>): RawRecord {
  const id = `${log.block.number}:${log.rawEvent.logIndex}`;
  return {
    id,
    callId: id,
    data: {
      kind: "log",
      event,
      block_number: log.block.number,
      timestamp: log.timestamp.toISOString(),
      tx_hash: log.rawEvent.transactionHash,
      log_index: log.rawEvent.logIndex,
      contract: log.contract,
      args: log.event,
    },
  };
}

/**
 * Every OrderFilled of the three CTF Exchange v2 contracts on Polygon, as emitted, from START_BLOCK to
 * Portal's finalized head when the run starts. With `wallets` in addresses.json, only the fills whose
 * maker is listed.
 *
 * Each match emits one OrderFilled per maker order and one for the taker order, whose taker is the
 * exchange itself. Both are loaded; dbt keeps the right ones. Which side, price and fee a fill has is left
 * to dbt too. OrdersMatched and FeeCharged repeat what the fills hold and are not loaded, and v2 emits no
 * token registry event (catalog/protocols/polymarket/NOTES.md, Q3).
 */
export const polygonPolymarketCtfExchangeV2: StreamSource<ExchangeEnv> = {
  name: "polygon",
  table: "polymarket_ctf_exchange_v2",
  coverage: { unrestricted: ["wallets"] },
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const listed = addresses.parse(readJson("addresses.json"));
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: evmEventDecoder({
        range,
        contracts: listed.exchanges.map(toLower),
        events: {
          OrderFilled: listed.wallets
            ? { event: events.OrderFilled!, params: { maker: listed.wallets.map(toLower) } }
            : events.OrderFilled!,
        },
      }).pipe((logs) =>
        Object.values(logs).flatMap((found) => found.map((log) => logRecord("ctf_exchange_v2.OrderFilled", log))),
      ),
    });
  },
};
