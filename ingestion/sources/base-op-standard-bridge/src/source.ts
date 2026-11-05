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
import bridgeAbi from "../../../../catalog/protocols/op-standard-bridge/abis/l2-standard-bridge.json" with { type: "json" };

// The contract system, from catalog/protocols/op-standard-bridge/protocol.yaml: Base's L2StandardBridge
// predeploy, which burns a token on withdrawal and mints it on deposit. Its legacy WithdrawalInitiated
// and DepositFinalized repeat the two events below with the same values, so only these two are read.
export const BRIDGE = "0x4200000000000000000000000000000000000010";
const EVENTS = ["ERC20BridgeInitiated", "ERC20BridgeFinalized"] as const;
// The catalog's ABI files are JSON, so their events are typed by name only.
const events = defineAbi(bridgeAbi as readonly JsonAbiItem[]).events;

const env = z.object({
  PORTAL_URL: z.url().default("https://portal.sqd.dev/datasets/base-mainnet"),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type StandardBridgeEnv = z.infer<typeof env>;

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
 * The bridge's ERC20BridgeInitiated and ERC20BridgeFinalized logs of the Base tokens in addresses.json,
 * as emitted, from START_BLOCK to Portal's finalized head when the run starts. The filter is on
 * localToken: another Base token can name the same remote token.
 */
export const source: StreamSource<StandardBridgeEnv> = {
  name: "base",
  table: "op_standard_bridge",
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const { default: addresses } = await import("../addresses.json", { with: { type: "json" } });
    const tokens = validateEthAddressList(addresses.tokens).map((a) => a.toLowerCase());
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };

    // One decoder per event: Pipes refuses two filters on the same event in one decoder (E0004).
    const decoder = (event: (typeof EVENTS)[number]) =>
      evmEventDecoder({
        range,
        contracts: [BRIDGE],
        events: { logs: { event: events[event]!, params: { localToken: tokens } as Record<"localToken", string[]> } },
      }).pipe(({ logs }) => logs.map((log) => logRecord(event, log)));

    return evmPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: { initiated: decoder("ERC20BridgeInitiated"), finalized: decoder("ERC20BridgeFinalized") },
    });
  },
};
