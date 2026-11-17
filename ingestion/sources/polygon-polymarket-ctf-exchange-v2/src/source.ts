import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { address, toLower } from "@ingestion/lib/evm";
import {
  defineAbi,
  evmEventDecoder,
  evmPortalStream,
  evmQuery,
  type DecodedEvent,
  type JsonAbiItem,
} from "@subsquid/pipes/evm";
import * as z from "zod";
import exchangeAbi from "../../../../catalog/protocols/polymarket/abis/ctf-exchange-v2.json" with { type: "json" };

// The catalog's ABI file is JSON, so its events and functions are typed by name only.
const { events, functions } = defineAbi(exchangeAbi as readonly JsonAbiItem[]);
const matchOrders = functions.matchOrders!;

const defaultPortalUrl = "https://portal.sqd.dev/datasets/polygon-mainnet";

const env = z.object({
  PORTAL_URL: z.url().default(defaultPortalUrl),
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

// Each record is one item as Portal returns it. A log is unique by its block and its index in that block,
// and its event is the catalog's key for the ABI event. A transaction is unique by its hash.
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

type Transaction = { hash: string; from: string; to?: string; input: string };

// A matchOrders call keeps its arguments decoded, the signed orders among them; any other call keeps its
// input as sent, since the catalog has no ABI to decode it.
function transactionRecord(header: { number: number; timestamp: number }, tx: Transaction): RawRecord {
  const id = `tx:${tx.hash}`;
  const call = matchOrders.is(tx.input)
    ? { function: "matchOrders", args: matchOrders.decode(tx.input) }
    : { function: null, input: tx.input };
  return {
    id,
    callId: id,
    data: {
      kind: "transaction",
      block_number: header.number,
      timestamp: new Date(header.timestamp * 1000).toISOString(),
      hash: tx.hash,
      from: tx.from,
      to: tx.to ?? null,
      ...call,
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
 *
 * Also the transactions those fills came from, as records of their own. A fill names its order only by
 * hash; the transaction's matchOrders input holds the signed orders themselves: posted amounts, signer,
 * salt and the time each was signed (NOTES.md, Q12).
 */
export const polygonPolymarketCtfExchangeV2: StreamSource<ExchangeEnv> = {
  name: "polygon",
  table: "polymarket_ctf_exchange_v2",
  coverage: { defaultPortalUrl, filters: Object.keys(addresses.shape), unrestricted: ["wallets"] },
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
      outputs: {
        // The decoder asks Portal for each fill's transaction; this output reads them.
        transactions: evmQuery().addFields({
          block: { number: true, timestamp: true },
          transaction: { hash: true, from: true, to: true, input: true },
        }),
        fills: evmEventDecoder({
          range,
          contracts: listed.exchanges.map(toLower),
          events: {
            OrderFilled: listed.wallets
              ? { event: events.OrderFilled!, params: { maker: listed.wallets.map(toLower) } }
              : events.OrderFilled!,
          },
        }),
      },
    }).pipe(({ transactions, fills }) => {
      const logs = Object.values(fills).flat();
      const written = new Set(logs.map((log) => log.rawEvent.transactionHash));
      return [
        ...logs.map((log) => logRecord("ctf_exchange_v2.OrderFilled", log)),
        ...transactions.flatMap((block) =>
          block.transactions.filter((tx) => written.has(tx.hash)).map((tx) => transactionRecord(block.header, tx)),
        ),
      ];
    });
  },
};
