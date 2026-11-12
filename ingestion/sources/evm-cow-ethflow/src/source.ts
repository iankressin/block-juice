import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { validateEthAddressList } from "@ingestion/lib/evm";
import { evmPortalStream, evmQuery } from "@subsquid/pipes/evm";
import { decodeEventLog, type Abi, type Hex } from "viem";
import * as z from "zod";
import erc20Abi from "../../../../catalog/protocols/cow-protocol/abis/erc20.json" with { type: "json" };
import ethFlowAbi from "../../../../catalog/protocols/cow-protocol/abis/eth-flow.json" with { type: "json" };
import settlementAbi from "../../../../catalog/protocols/cow-protocol/abis/gpv2-settlement.json" with { type: "json" };

const env = z.object({
  // The chain's Portal dataset, set in chains/<chain>/.env.example.
  PORTAL_URL: z.url(),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type CowEthFlowEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

// topic0 of each event this source keeps, from the catalog's ABIs (catalog/protocols/cow-protocol).
export const TOPICS = {
  OrderPlacement: "0xcf5f9de2984132265203b5c335b25727702ca77262ff622e136baa7362bf1da9",
  Trade: "0xa07a543ab8a018198e99ca0184c93fe9050a79400a0a723441f84de1d972cc17",
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
} as const;

// CoWSwapEthFlow.createOrder(EthFlowOrder.Data), which returns the order's GPv2 order hash.
export const CREATE_ORDER = "0x322bba21";

const abis = { OrderPlacement: ethFlowAbi, Trade: settlementAbi, Transfer: erc20Abi } as Record<string, Abi>;

const fields = {
  block: { number: true, hash: true, timestamp: true },
  transaction: { transactionIndex: true, hash: true },
  log: { logIndex: true, transactionIndex: true, transactionHash: true, address: true, data: true, topics: true },
  trace: {
    type: true,
    transactionIndex: true,
    traceAddress: true,
    error: true,
    callFrom: true,
    callTo: true,
    callValue: true,
    callInput: true,
    callSighash: true,
    callResultOutput: true,
  },
} as const;

type Header = { number: number; hash: string; timestamp: number };
type Log = { logIndex: number; transactionIndex: number; transactionHash: string; address: string; data: string; topics: string[] };
type Trace = {
  type: string;
  transactionIndex: number;
  traceAddress: number[];
  error: string | null;
  action?: { from?: string; to?: string; value?: bigint; input?: string; sighash?: string };
  result?: { output?: string };
};
type Block = { header: Header; transactions: { transactionIndex: number; hash: string }[]; logs: Log[]; traces: Trace[] };

export type Filter = { wallets: Set<string>; ethFlow: Set<string>; settlement: Set<string> };

const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}` as Hex;
const topicAddress = (t?: string) => (t ? `0x${t.slice(-40)}`.toLowerCase() : undefined);

/** Which event a log is, when it is one this source keeps, or undefined. */
export function keptEvent(log: Log, f: Filter): keyof typeof TOPICS | undefined {
  const [topic0, topic1, topic2] = log.topics;
  const address = log.address.toLowerCase();
  if (topic0 === TOPICS.OrderPlacement && f.ethFlow.has(address) && f.wallets.has(topicAddress(topic1)!)) {
    return "OrderPlacement";
  }
  if (topic0 === TOPICS.Trade && f.settlement.has(address)) return "Trade";
  // An ERC-20 Transfer has three topics; an ERC-721 Transfer, with the same topic0, has four.
  if (topic0 === TOPICS.Transfer && log.topics.length === 3 && f.wallets.has(topicAddress(topic2)!)) return "Transfer";
  return undefined;
}

/**
 * The records of one block, each one item as Portal returns it, keyed by its place in the chain:
 * - a kept log (`<block>:<logIndex>`) with its ABI-decoded arguments;
 * - a createOrder call to an ETH Flow contract from a wallet (`<block>:<txIndex>:trace:<traceAddress>`),
 *   with its input and output, the order hash ETH Flow returned.
 * A settlement's Trade logs are kept only in the transactions this source matched, those with a
 * Transfer into a wallet, so they are other traders' Trades too; dbt keeps the ones it needs.
 */
export function blockRecords(block: Block, f: Filter): RawRecord[] {
  const number = block.header.number;
  const timestamp = new Date(block.header.timestamp * 1000).toISOString();
  const hashes = new Map(block.transactions.map((tx) => [tx.transactionIndex, tx.hash]));
  const record = (id: string, data: Record<string, unknown>): RawRecord => ({
    id,
    callId: id,
    data: { ...data, block_number: number, block_hash: block.header.hash, timestamp },
  });
  const logs = block.logs.flatMap((log) => {
    const event = keptEvent(log, f);
    if (!event) return [];
    const decoded = decodeEventLog({ abi: abis[event]!, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
    return [
      record(`${number}:${log.logIndex}`, {
        kind: "log",
        event,
        tx_hash: log.transactionHash,
        transaction_index: log.transactionIndex,
        log_index: log.logIndex,
        contract: log.address,
        args: decoded.args,
      }),
    ];
  });
  const traces = block.traces
    .filter(
      (t) =>
        t.type === "call" &&
        t.action?.sighash === CREATE_ORDER &&
        f.ethFlow.has(t.action.to?.toLowerCase() ?? "") &&
        f.wallets.has(t.action.from?.toLowerCase() ?? ""),
    )
    .map((t) =>
      record(`${number}:${t.transactionIndex}:trace:${t.traceAddress.join(".")}`, {
        kind: "trace",
        tx_hash: hashes.get(t.transactionIndex) ?? null,
        transaction_index: t.transactionIndex,
        trace_address: t.traceAddress,
        error: t.error,
        from: t.action!.from,
        to: t.action!.to,
        value: t.action!.value ?? null,
        sighash: t.action!.sighash,
        input: t.action!.input ?? null,
        output: t.result?.output ?? null,
      }),
    );
  return [...logs, ...traces];
}

/**
 * What the CoW Protocol ETH Flow orders of the wallets in chains/<chain>/addresses.json need, on one
 * EVM chain, up to Portal's finalized head when the run starts:
 * - each OrderPlacement an ETH Flow contract emitted with a wallet as sender;
 * - each createOrder call from a wallet to an ETH Flow contract, whose output is the order hash, the
 *   first 32 bytes of the order's UID, so dbt can match the order without hashing;
 * - each ERC-20 Transfer into a wallet, and the GPv2Settlement Trade logs in the same transaction.
 * The source is named for its chain, so each chain loads into raw.<chain>_cow_ethflow.
 */
export const forChain = (chain: string): StreamSource<CowEthFlowEnv> => ({
  name: chainName.parse(chain),
  table: "cow_ethflow",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const path = `chains/${chain}/addresses.json`;
    const addresses = readJson(path);
    const list = (key: string) => {
      const listed = addresses[key];
      if (!Array.isArray(listed) || listed.length === 0) throw new Error(`${path} lists no ${key}`);
      return validateEthAddressList(listed).map((a) => a.toLowerCase() as Hex);
    };
    const wallets = list("wallets");
    const ethFlow = list("ethFlow");
    const settlement = list("settlement");
    const filter: Filter = { wallets: new Set(wallets), ethFlow: new Set(ethFlow), settlement: new Set(settlement) };
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    const query = evmQuery()
      .addFields(fields)
      .addLogRequest({
        range,
        request: { address: ethFlow, topic0: [TOPICS.OrderPlacement], topic1: wallets.map(pad) },
      })
      .addLogRequest({
        range,
        request: { topic0: [TOPICS.Transfer], topic2: wallets.map(pad), transactionLogs: true },
      })
      .addTraceRequest({
        range,
        request: { type: ["call"], callFrom: wallets, callTo: ethFlow, callSighash: [CREATE_ORDER], transaction: true },
      });

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: query.build().pipe((blocks) => blocks.flatMap((block) => blockRecords(block as unknown as Block, filter))),
    });
  },
});
