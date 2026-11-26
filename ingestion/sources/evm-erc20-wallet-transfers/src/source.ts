import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { validateEthAddressList } from "@ingestion/lib/evm";
import {
  commonAbis,
  evmEventDecoder,
  evmPortalStream,
  type DecodedEvent,
  type IndexedParamsInput,
} from "@subsquid/pipes/evm";
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

export type TransfersEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `arbitrum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as arbitrum");

const Transfer = commonAbis.erc20.events.Transfer;

// A log is unique by its block and its index in that block.
const toRecord = (t: DecodedEvent<ReturnType<typeof Transfer.decode>>): RawRecord => {
  const id = `${t.block.number}:${t.rawEvent.logIndex}`;
  return {
    id,
    callId: id,
    data: {
      block_number: t.block.number,
      timestamp: t.timestamp.toISOString(),
      tx_hash: t.rawEvent.transactionHash,
      log_index: t.rawEvent.logIndex,
      token: t.contract,
      from: t.event.from,
      to: t.event.to,
      value: t.event.value,
    },
  };
};

/**
 * The Transfers of the tokens in chains/<chain>/addresses.json into or out of the wallets listed there,
 * on one EVM chain, up to Portal's finalized head when the run starts. The source is named for its
 * chain, so each chain loads into raw.<chain>_erc20_wallet_transfers with a cursor of its own.
 *
 * Unlike evm-erc20-transfers, `wallets` is required: this source follows a set of wallets in a token
 * without narrowing what evm-erc20-transfers reads on the same chain. A transfer between two of them
 * is in both outputs, under the same id, so the warehouse keeps one row.
 */
export const forChain = (chain: string): StreamSource<TransfersEnv> => ({
  name: chainName.parse(chain),
  table: "erc20_wallet_transfers",
  coverage: { filters: ["tokens", "wallets"], unrestricted: [] },
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson(`chains/${chain}/addresses.json`);
    const tokens = validateEthAddressList(addresses.tokens);
    if (!Array.isArray(addresses.wallets) || addresses.wallets.length === 0) {
      throw new Error(`chains/${chain}/addresses.json must list wallets; evm-erc20-transfers reads every transfer`);
    }
    const wallets = validateEthAddressList(addresses.wallets).map((a: string) => a.toLowerCase());
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    // One decoder per filter: Pipes refuses two filters on the same event in one decoder (E0004).
    const transfers = (params: IndexedParamsInput<typeof Transfer>) =>
      evmEventDecoder({ range, contracts: tokens, events: { transfers: { event: Transfer, params } } }).pipe(
        ({ transfers }) => transfers.map(toRecord),
      );

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: { incoming: transfers({ to: wallets }), outgoing: transfers({ from: wallets }) },
    });
  },
});
