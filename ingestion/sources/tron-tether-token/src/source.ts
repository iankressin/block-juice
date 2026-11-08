import assert from "node:assert/strict";
import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import type { PortalClientOptions } from "@subsquid/pipes/portal-client";
import { tronPortalStream, tronQuery, type TronPortalData } from "@subsquid/pipes/tron";
import { decodeEventLog, toEventSelector, type AbiEvent, type Hex } from "viem";
import * as z from "zod";
import abi from "../../../../catalog/protocols/tether-token/abis/tether-token-tron.json" with {
  type: "json",
};
import {
  tronAddressFromHex,
  tronAddressFromPrefixedHex,
  tronAddressToHex,
  validateTronAddressList,
  type TronAddress,
} from "#src/address.ts";

// Every Tether event except Approval and OwnershipTransferred, by name in the catalog's TRON ABI.
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
// Portal takes a few hundred addresses in one log request; a token list is far shorter.
const TOKENS_MAX = 100;

/** The tracked events by topic0, as Portal writes topics: hex without 0x. */
const TRACKED: ReadonlyMap<string, AbiEvent> = new Map(
  EVENTS.map((name) => {
    const event = (abi as readonly AbiEvent[]).find((item) => item.name === name);
    assert.ok(event, `${name} is missing from tether-token-tron.json`);
    assert.equal(event.type, "event");
    return [toEventSelector(event).slice(2), event];
  }),
);
assert.equal(TRACKED.size, EVENTS.length, "no two tracked events share a topic0");

const FIELDS = {
  block: { number: true, hash: true, timestamp: true },
  log: { transactionIndex: true, logIndex: true, address: true, data: true, topics: true },
  transaction: {
    transactionIndex: true,
    hash: true,
    type: true,
    result: true,
    ret: true,
    parameter: true,
  },
} as const;

type Block = TronPortalData<typeof FIELDS>[number];
type Header = Block["header"];
type Log = Block["logs"][number];
type Transaction = Block["transactions"][number];

const env = z
  .object({
    // tron-mainnet's Portal dataset.
    PORTAL_URL: z.url(),
    // Sent with every Portal request when set. Without one, the public Portal answers at its
    // anonymous limits.
    PORTAL_API_KEY: z.string().optional(),
    // The first block to read. Later runs resume after the cursor Pipes keeps in the warehouse.
    START_BLOCK: z.coerce.number().int().nonnegative(),
    // The last block to read, set only to check a short window. Unset, each run ends at Portal's
    // finalized head.
    END_BLOCK: z.coerce.number().int().positive().optional(),
  })
  .refine((e) => e.END_BLOCK === undefined || e.END_BLOCK >= e.START_BLOCK, {
    message: "END_BLOCK must not be before START_BLOCK",
  });

export type TronTetherTokenEnv = z.infer<typeof env>;

const addressesFile = z.strictObject({
  tokens: z.array(z.unknown()).min(1).max(TOKENS_MAX),
});

/** The tokens in addresses.json. Another key, such as `wallets`, fails: there is no filter. */
function tokensOf(file: unknown): TronAddress[] {
  const parsed = addressesFile.safeParse(file);
  if (!parsed.success) throw new Error(`addresses.json: ${z.prettifyError(parsed.error)}`);
  const tokens = validateTronAddressList(parsed.data.tokens);
  assert.ok(tokens.length >= 1);
  assert.ok(tokens.length <= TOKENS_MAX);
  return tokens;
}

const isoOf = (timestampMs: number): string => {
  assert.ok(Number.isSafeInteger(timestampMs), `bad block timestamp ${timestampMs}`);
  assert.ok(timestampMs > 0, `bad block timestamp ${timestampMs}`);
  return new Date(timestampMs).toISOString();
};

/** A log's arguments by name: addresses in Base58Check, integers as decimal strings. */
function decodeArgs(event: AbiEvent, log: Log): Record<string, string> {
  const [topic0, ...indexed] = log.topics ?? [];
  assert.ok(topic0 !== undefined, "a tracked log has its topic0");
  const topics: [Hex, ...Hex[]] = [`0x${topic0}`, ...indexed.map((t) => `0x${t}` as Hex)];
  const data: Hex = `0x${log.data ?? ""}`;
  const decoded = decodeEventLog({ abi: [event], data, topics, strict: true });
  const values = (decoded.args ?? {}) as Record<string, unknown>;
  const args: Record<string, string> = {};
  for (const input of event.inputs) {
    assert.ok(input.name, `${event.name} has an unnamed input`);
    const value = values[input.name];
    if (input.type === "address") {
      assert.equal(typeof value, "string");
      args[input.name] = tronAddressFromHex((value as string).slice(2));
    } else if (input.type.startsWith("uint")) {
      assert.equal(typeof value, "bigint");
      args[input.name] = (value as bigint).toString();
    } else {
      throw new Error(`${event.name}.${input.name} has type ${input.type}, which is not written`);
    }
  }
  return args;
}

function blockRecord(header: Header): RawRecord {
  const id = `block:${header.number}`;
  const data = {
    kind: "block",
    block_number: header.number,
    block_hash: header.hash,
    timestamp: isoOf(header.timestamp),
  };
  return { id, callId: id, data };
}

function logRecord(header: Header, log: Log, tx: Transaction, contract: TronAddress): RawRecord {
  // logIndex restarts in every TRON transaction, so the transaction's index is part of the key.
  const id = `${header.number}:${log.transactionIndex}:${log.logIndex}`;
  const event = TRACKED.get(log.topics?.[0] ?? "");
  assert.ok(event, `log ${id} has an untracked topic0`);
  assert.equal(tx.transactionIndex, log.transactionIndex);
  const data = {
    kind: "log",
    event: event.name,
    block_number: header.number,
    block_hash: header.hash,
    timestamp: isoOf(header.timestamp),
    tx_hash: tx.hash,
    tx_index: log.transactionIndex,
    log_index: log.logIndex,
    contract,
    args: decodeArgs(event, log),
  };
  return { id, callId: id, data };
}

function transactionRecord(header: Header, tx: Transaction): RawRecord {
  const owner: unknown = tx.parameter.value.owner_address;
  if (typeof owner !== "string") throw new Error(`transaction ${tx.hash} names no owner_address`);
  const id = `tx:${tx.hash}`;
  const data = {
    kind: "transaction",
    block_number: header.number,
    tx_index: tx.transactionIndex,
    hash: tx.hash,
    type: tx.type,
    result: tx.result ?? null,
    contract_ret: tx.ret?.[0]?.contractRet ?? null,
    owner: tronAddressFromPrefixedHex(owner),
  };
  return { id, callId: id, data };
}

/**
 * Each block, each log of the tokens with a tracked topic0, and the transactions of those logs, as
 * records. Portal filtered the logs; one outside the filter means the query and Portal disagree.
 */
function recordsOf(blocks: readonly Block[], tokens: ReadonlySet<TronAddress>): RawRecord[] {
  const records: RawRecord[] = [];
  for (const block of blocks) {
    const { header } = block;
    records.push(blockRecord(header));
    const transactions = new Map(block.transactions.map((tx) => [tx.transactionIndex, tx]));
    const written = new Set<number>();
    for (const log of block.logs) {
      const contract = tronAddressFromHex(log.address);
      if (!tokens.has(contract)) {
        throw new Error(`Portal sent a log of ${contract}, which is no tracked token`);
      }
      const tx = transactions.get(log.transactionIndex);
      if (!tx) {
        const place = `${header.number}:${log.transactionIndex}`;
        throw new Error(`Portal sent log ${place} without its transaction`);
      }
      records.push(logRecord(header, log, tx, contract));
      written.add(log.transactionIndex);
    }
    for (const index of [...written].sort((a, b) => a - b)) {
      records.push(transactionRecord(header, transactions.get(index)!));
    }
  }
  return records;
}

// Every block from START_BLOCK, every tracked log of the tokens in addresses.json, and the
// transactions of those logs, each as Portal returns it. Which logs move supply is dbt's to say.
export const tronTetherToken: StreamSource<TronTetherTokenEnv> = {
  name: "tron",
  table: "tether_token",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const tokens = tokensOf(readJson("addresses.json"));
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const to = Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal));
    const range = { from: env.START_BLOCK, to };
    const logs = {
      address: tokens.map(tronAddressToHex),
      topic0: [...TRACKED.keys()],
      transaction: true,
    };
    const query = tronQuery()
      .addFields(FIELDS)
      .addLogRequest({ range, request: logs })
      .includeAllBlocks(range);
    const tracked = new Set(tokens);
    return tronPortalStream({
      id: `${this.name}_${this.table}`,
      // tronPortalStream's type leaves out the PortalClient that evmPortalStream takes, though both
      // pass the portal to the same PortalStream, which uses a client as given.
      portal: portal as unknown as PortalClientOptions,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: query,
    }).pipe((blocks) => recordsOf(blocks, tracked));
  },
};
