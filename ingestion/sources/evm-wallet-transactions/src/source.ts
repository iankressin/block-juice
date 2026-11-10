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
import * as z from "zod";

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

export type WalletTransactionsEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

// The transaction and receipt fields each record keeps, as Portal returns them. The fee is dbt's to work out.
const fields = {
  block: { number: true, hash: true, timestamp: true },
  transaction: {
    transactionIndex: true,
    hash: true,
    nonce: true,
    from: true,
    to: true,
    value: true,
    type: true,
    status: true,
    gasUsed: true,
    gasPrice: true,
    effectiveGasPrice: true,
    blobGasUsed: true,
    blobGasPrice: true,
    contractAddress: true,
    sighash: true,
  },
} as const;

type Header = { number: number; hash: string; timestamp: number };
type Tx = {
  transactionIndex: number;
  hash: string;
  nonce: bigint | number;
  from: string;
  to?: string | null;
  value: bigint;
  type?: number;
  status: number;
  gasUsed: bigint;
  gasPrice: bigint;
  effectiveGasPrice?: bigint;
  blobGasUsed?: bigint;
  blobGasPrice?: bigint;
  contractAddress?: string | null;
  sighash?: string | null;
};

// A transaction is unique by its hash. One that both sends from and goes to listed wallets comes in
// both outputs under the same id, so the warehouse keeps one row.
export function transactionRecord(header: Header, tx: Tx): RawRecord {
  const id = `tx:${tx.hash}`;
  return {
    id,
    callId: id,
    data: {
      kind: "transaction",
      block_number: header.number,
      block_hash: header.hash,
      timestamp: new Date(header.timestamp * 1000).toISOString(),
      transaction_index: tx.transactionIndex,
      hash: tx.hash,
      nonce: tx.nonce,
      from: tx.from,
      to: tx.to ?? null,
      value: tx.value,
      type: tx.type ?? null,
      status: tx.status,
      gas_used: tx.gasUsed,
      gas_price: tx.gasPrice,
      effective_gas_price: tx.effectiveGasPrice ?? null,
      blob_gas_used: tx.blobGasUsed ?? null,
      blob_gas_price: tx.blobGasPrice ?? null,
      contract_address: tx.contractAddress ?? null,
      sighash: tx.sighash ?? null,
    },
  };
}

/**
 * The top-level transactions sent from or to the wallets in chains/<chain>/addresses.json on one EVM
 * chain, each with its receipt's fields, up to Portal's finalized head when the run starts. Internal
 * transfers, which only traces show, are not here. The source is named for its chain, so each chain
 * loads into raw.<chain>_wallet_transactions with a cursor of its own.
 */
export const forChain = (chain: string): StreamSource<WalletTransactionsEnv> => ({
  name: chainName.parse(chain),
  table: "wallet_transactions",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const path = `chains/${chain}/addresses.json`;
    const listed = readJson(path).wallets;
    // With no wallets the query keeps no transaction, yet the cursor still moves past the blocks it read.
    if (!Array.isArray(listed) || listed.length === 0) throw new Error(`${path} lists no wallets`);
    const wallets = validateEthAddressList(listed).map((a) => a.toLowerCase() as `0x${string}`);
    const set = new Set<string>(wallets);
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    // One request per side: Portal ANDs the fields of one request, and a transaction matches either side.
    // Portal answers both in one list, so a transaction between two wallets comes once.
    const query = evmQuery()
      .addFields(fields)
      .addTransactionRequest({ range, request: { from: wallets } })
      .addTransactionRequest({ range, request: { to: wallets } });

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: query.build().pipe((blocks) =>
        blocks.flatMap((block) => {
          const seen = new Set<string>();
          const listed = (a?: string | null) => a != null && set.has(a.toLowerCase());
          return block.transactions
            .filter((tx) => (listed(tx.from) || listed(tx.to)) && !seen.has(tx.hash) && seen.add(tx.hash))
            .map((tx) => transactionRecord(block.header as Header, tx as Tx));
        }),
      ),
    });
  },
});
