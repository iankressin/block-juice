import {
  finalizedHead,
  logger,
  portalClient,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { validateEthAddressList } from "@ingestion/lib/evm";
import { defineAbi, evmEventDecoder, evmPortalStream, type DecodedEvent, type JsonAbiItem } from "@subsquid/pipes/evm";
import * as z from "zod";
import gatewayAbi from "../../../../catalog/protocols/arbitrum-token-bridge/abis/l2-gateway.json" with { type: "json" };

// The contract system, from catalog/protocols/arbitrum-token-bridge/protocol.yaml: the L2 Arb-Custom
// Gateway, which burns a token on withdrawal and mints it on deposit, and emits both events below.
export const GATEWAY = "0x096760f208390250649e3e8763348e783aef5562";
// The catalog's ABI files are JSON, so their events are typed by name only.
const events = defineAbi(gatewayAbi as readonly JsonAbiItem[]).events;

const env = z.object({
  PORTAL_URL: z.url().default("https://portal.sqd.dev/datasets/arbitrum-one"),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type TokenBridgeEnv = z.infer<typeof env>;

// Each record is one log as Portal returns it, unique by its block and its index in that block.
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
 * The gateway's logs as emitted: every DepositFinalized of the Ethereum tokens in addresses.json, and
 * every WithdrawalInitiated, whose token is not indexed, so the query cannot filter it; dbt keeps the
 * tokens it needs. From START_BLOCK to Portal's finalized head when the run starts.
 */
export const source: StreamSource<TokenBridgeEnv> = {
  name: "arbitrum",
  table: "token_bridge",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const { default: addresses } = await import("../addresses.json", { with: { type: "json" } });
    const tokens = validateEthAddressList(addresses.tokens).map((a) => a.toLowerCase());
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: {
        deposits: evmEventDecoder({
          range,
          contracts: [GATEWAY],
          events: { logs: { event: events.DepositFinalized!, params: { l1Token: tokens } as Record<"l1Token", string[]> } },
        }).pipe(({ logs }) => logs.map((log) => logRecord("DepositFinalized", log))),
        withdrawals: evmEventDecoder({
          range,
          contracts: [GATEWAY],
          events: { logs: events.WithdrawalInitiated! },
        }).pipe(({ logs }) => logs.map((log) => logRecord("WithdrawalInitiated", log))),
      },
    });
  },
};
