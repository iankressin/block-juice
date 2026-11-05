import { existsSync } from "node:fs";
import {
  finalizedHead,
  logger,
  portalClient,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { validateEthAddressList } from "@ingestion/lib/evm";
import {
  contractFactory,
  contractFactorySqliteStore,
  defineAbi,
  evmEventDecoder,
  evmPortalStream,
  evmQuery,
  type DecodedEvent,
  type JsonAbiItem,
} from "@subsquid/pipes/evm";
import * as z from "zod";
import factoryAbi from "../../../../catalog/protocols/uniswap/abis/v2-factory.json" with { type: "json" };
import pairAbi from "../../../../catalog/protocols/uniswap/abis/v2-pair.json" with { type: "json" };

// The contract system, from catalog/protocols/uniswap/protocol.yaml: the factory, the event it emits
// for each pair it creates, the argument that holds the pair's address, and the pairs' own event.
const FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const FACTORY_DEPLOYED_BLOCK = 10000835;
const CREATED = "PairCreated";
const CHILD_ADDRESS = "pair";
const CHILD_EVENT = "Swap";
// The catalog's ABI files are JSON, so their events are typed by name only.
const events = (abi: readonly JsonAbiItem[]) => defineAbi(abi).events;
const factoryEvents = events(factoryAbi);
const childEvents = events(pairAbi);

const env = z
  .object({
    PORTAL_URL: z.url().default("https://portal.sqd.dev/datasets/ethereum-mainnet"),
    // The first block of pool creations. A pool created before START_BLOCK still trades after it.
    POOLS_START_BLOCK: z.coerce.number().int().nonnegative().default(FACTORY_DEPLOYED_BLOCK),
    // The first block of Swaps. Later runs resume after the cursor Pipes keeps in the warehouse.
    START_BLOCK: z.coerce.number().int().nonnegative(),
    // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
    END_BLOCK: z.coerce.number().int().positive().optional(),
    // Where Pipes' factory pattern keeps the pools it has found, relative to the package.
    FACTORY_DB: z.string().min(1).default("factory.sqlite"),
  })
  .refine((e) => e.POOLS_START_BLOCK <= e.START_BLOCK, {
    message: "POOLS_START_BLOCK must not be after START_BLOCK, or the Swaps of pools created between them are lost",
  });

export type FactorySourceEnv = z.infer<typeof env>;

type Log = Omit<DecodedEvent<Record<string, unknown>>, "factory">;

// Each record is one item as Portal returns it. A log is unique by its block and its index in that
// block, a transaction by its hash.
function logRecord(event: string, log: Log): RawRecord {
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

function transactionRecord(blockNumber: number, tx: { hash: string; from: string }): RawRecord {
  const id = `tx:${tx.hash}`;
  return { id, callId: id, data: { kind: "transaction", block_number: blockNumber, hash: tx.hash, from: tx.from } };
}

// Uniswap v2 logs of the tokens in addresses.json, each as emitted: every PairCreated naming a token,
// from POOLS_START_BLOCK, and every Swap of those pairs, from START_BLOCK. Also the transactions those
// logs came from, as records of their own.
// Pipes' factory pattern follows the pairs. Which token a Swap bought is dbt's to work out.
export const ethereumUniswapV2: StreamSource<FactorySourceEnv> = {
  name: "ethereum",
  table: "uniswap_v2",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const { default: addresses } = await import("../addresses.json", { with: { type: "json" } });
    const tokens = validateEthAddressList(addresses.tokens).map((a) => a.toLowerCase());
    const portal = portalClient(env.PORTAL_URL);
    const to = Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal));
    const storeIsNew = !existsSync(env.FACTORY_DB);
    const database = contractFactorySqliteStore({ path: env.FACTORY_DB });

    // A pool holds a token as token0 or token1, and a filter names one side, so each side gets its own
    // decoders: Pipes refuses two filters on the same event in one decoder (E0004). A factory learns its
    // pools from every creation log in a batch, whichever decoder asked for it, so the pools created
    // before START_BLOCK are known when its Swaps start.
    const side = (token: "token0" | "token1") => {
      const created = { event: factoryEvents[CREATED]!, params: { [token]: tokens } as Record<typeof token, string[]> };
      const pools = contractFactory({ address: FACTORY, event: created, childAddressField: CHILD_ADDRESS, database });
      return {
        created: evmEventDecoder({
          range: { from: env.POOLS_START_BLOCK, to },
          contracts: [FACTORY],
          events: { logs: created },
        }).pipe(({ logs }) => logs.map((log) => ({ event: CREATED, log }))),
        children: evmEventDecoder({
          range: { from: env.START_BLOCK, to },
          contracts: pools,
          events: { logs: childEvents[CHILD_EVENT]! },
        }).pipe(({ logs }) => logs.map((log) => ({ event: CHILD_EVENT, log }))),
      };
    };
    const [token0, token1] = [side("token0"), side("token1")];

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: {
        // The decoders ask Portal for each log's transaction; this output reads them.
        transactions: evmQuery().addFields({ block: { number: true }, transaction: { hash: true, from: true } }),
        created0: token0.created,
        children0: token0.children,
        created1: token1.created,
        children1: token1.children,
      },
    }).pipe({
      start({ state }) {
        if (state.current && storeIsNew) {
          throw new Error(
            `${env.FACTORY_DB} is new, but the cursor is at block ${state.current.number}: the pools created ` +
              "before the cursor are gone, so their Swaps would be missed. Reset the source and load it again.",
          );
        }
      },
      transform({ transactions, ...outputs }) {
        const logs = Object.values(outputs).flat();
        // Portal also sends the transactions of the logs the decoders dropped, such as other pools' Swaps.
        const written = new Set(logs.map(({ log }) => log.rawEvent.transactionHash));
        return [
          ...logs.map(({ event, log }) => logRecord(event, log)),
          ...transactions.flatMap((block) =>
            block.transactions.filter((tx) => written.has(tx.hash)).map((tx) => transactionRecord(block.header.number, tx)),
          ),
        ];
      },
    });
  },
};
