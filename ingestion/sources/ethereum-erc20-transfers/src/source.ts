import {
  finalizedHead,
  logger,
  portalClient,
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
  PORTAL_URL: z.url().default("https://portal.sqd.dev/datasets/ethereum-mainnet"),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
});

export type TransfersEnv = z.infer<typeof env>;

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

// Every Transfer of the tokens in addresses.json into or out of its wallets, up to Portal's
// finalized head when the run starts. A transfer between two of the wallets is in both
// outputs, under the same id, so the warehouse keeps one row.
export const ethereumErc20Transfers: StreamSource<TransfersEnv> = {
  name: "ethereum",
  table: "erc20_transfers",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const { default: addresses } = await import("../addresses.json", { with: { type: "json" } });
    const wallets = validateEthAddressList(addresses.wallets).map((a) => a.toLowerCase());
    const tokens = validateEthAddressList(addresses.tokens);
    const portal = portalClient(env.PORTAL_URL);
    const range = { from: env.START_BLOCK, to: await finalizedHead(portal) };

    // One decoder per filter: Pipes refuses two filters on the same event in one decoder (E0004).
    const transfers = (params: IndexedParamsInput<typeof Transfer>) =>
      evmEventDecoder({ range, contracts: tokens, events: { transfers: { event: Transfer, params } } }).pipe(
        ({ transfers }) => transfers.map(toRecord),
      );

    return evmPortalStream({
      id: "ethereum-erc20-transfers",
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: { incoming: transfers({ to: wallets }), outgoing: transfers({ from: wallets }) },
    });
  },
};
