import assert from "node:assert/strict";
import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { validateEthAddressList } from "@ingestion/lib/evm";
import { EvmQueryBuilder, evmPortalStream, type EvmPortalData } from "@subsquid/pipes/evm";
import { decodeEventLog, toEventSelector, type Abi, type AbiEvent, type Hex } from "viem";
import * as z from "zod";
import tetherAbi from "../../../../catalog/protocols/tether-token/abis/tether-token-ethereum.json" with { type: "json" };

// Every event that moves tokens, changes the supply, or changes the rules a movement follows.
// Approval moves nothing, so it stays out.
const EVENTS = [
  "Transfer",
  "Issue",
  "Redeem",
  "DestroyedBlackFunds",
  "Deprecate",
  "Params",
  "AddedBlackList",
  "RemovedBlackList",
  "Pause",
  "Unpause",
] as const;

const abi = tetherAbi as Abi;
const TOPICS: Hex[] = EVENTS.map((name) => {
  const event = abi.find((item): item is AbiEvent => item.type === "event" && item.name === name);
  if (!event) throw new Error(`${name} is not in catalog/protocols/tether-token/abis/tether-token-ethereum.json`);
  return toEventSelector(event);
});

const env = z
  .object({
    // The chain's Portal dataset, set in chains/<chain>/.env.example.
    PORTAL_URL: z.url(),
    // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
    PORTAL_API_KEY: z.string().optional(),
    // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
    START_BLOCK: z.coerce.number().int().nonnegative(),
    // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
    END_BLOCK: z.coerce.number().int().positive().optional(),
  })
  .refine((e) => e.END_BLOCK === undefined || e.START_BLOCK <= e.END_BLOCK, {
    message: "END_BLOCK must not be before START_BLOCK",
  });

export type TetherTokenEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

const FIELDS = {
  block: { number: true, hash: true, timestamp: true },
  log: { address: true, topics: true, data: true, transactionHash: true, logIndex: true, transactionIndex: true },
  transaction: { hash: true, from: true, to: true, transactionIndex: true },
} as const;

type Block = EvmPortalData<typeof FIELDS>[number];

// Pipes' EVM query builder has no includeAllBlocks, though Portal takes the flag and Pipes' TRON and
// Bitcoin builders set it this same way. dbt needs every block to prove a day loaded end to end.
class EveryBlockQuery extends EvmQueryBuilder {
  includeAllBlocks(range: { from: number; to: number }) {
    this.requests.push({ range, request: { includeAllBlocks: true } });
    return this;
  }
}

function tokensIn(file: string): string[] {
  const addresses = readJson(file);
  if (addresses.wallets !== undefined) {
    throw new Error(`${file} lists wallets, but this source loads every log of its tokens: remove the key`);
  }
  if (!Array.isArray(addresses.tokens) || addresses.tokens.length === 0) {
    throw new Error(`${file} lists no tokens`);
  }
  return validateEthAddressList(addresses.tokens).map((a) => a.toLowerCase());
}

// ABI integers are bigints, and every big integer in a raw record is a decimal string.
const asText = (args: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

/**
 * One block as Portal returns it, as records: the block itself, each log of the tokens with its
 * ABI-decoded arguments, and the transactions those logs came from. A block is unique by its number,
 * a log by its block and its index in that block, a transaction by its hash.
 */
function recordsOf(block: Block, tokens: ReadonlySet<string>): RawRecord[] {
  const { number, hash } = block.header;
  const timestamp = new Date(block.header.timestamp * 1000).toISOString();
  const records: RawRecord[] = [
    { id: `block:${number}`, callId: `block:${number}`, data: { kind: "block", block_number: number, block_hash: hash, timestamp } },
  ];
  const written = new Set<string>();
  for (const log of block.logs) {
    assert(tokens.has(log.address), `Portal sent a log of ${log.address}, which addresses.json does not list`);
    const { eventName, args } = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    assert(
      eventName !== undefined && (EVENTS as readonly string[]).includes(eventName),
      `Portal sent a ${eventName} log, which the query does not ask for`,
    );
    const id = `${number}:${log.logIndex}`;
    records.push({
      id,
      callId: id,
      data: {
        kind: "log",
        event: eventName,
        block_number: number,
        block_hash: hash,
        timestamp,
        tx_hash: log.transactionHash,
        tx_index: log.transactionIndex,
        log_index: log.logIndex,
        contract: log.address,
        args: asText((args ?? {}) as Record<string, unknown>),
      },
    });
    written.add(log.transactionHash);
  }
  const transactions = block.transactions.filter((tx) => written.has(tx.hash));
  assert.equal(transactions.length, written.size, `Portal left out a transaction of a log in block ${number}`);
  for (const tx of transactions) {
    const id = `tx:${tx.hash}`;
    records.push({
      id,
      callId: id,
      data: { kind: "transaction", block_number: number, tx_index: tx.transactionIndex, hash: tx.hash, from: tx.from, to: tx.to ?? null },
    });
  }
  return records;
}

// Every block from START_BLOCK to Portal's finalized head, and every log of the tokens in
// chains/<chain>/addresses.json whose event is in EVENTS, each as emitted, with the transactions those
// logs came from. The history is contract-wide, so addresses.json takes no wallets. The source is
// named for its chain, so each chain loads into raw.<chain>_tether_token.
export const forChain = (chain: string): StreamSource<TetherTokenEnv> => ({
  name: chainName.parse(chain),
  table: "tether_token",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const tokens = tokensIn(`chains/${chain}/addresses.json`);
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };
    const query = new EveryBlockQuery()
      .includeAllBlocks(range)
      .addFields(FIELDS)
      .addLogRequest({ range, request: { address: tokens, topic0: TOPICS, transaction: true } });
    const listed = new Set(tokens);

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: query,
    }).pipe((blocks) => blocks.flatMap((block) => recordsOf(block, listed)));
  },
});
