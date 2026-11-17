import {
  finalizedHead,
  logger,
  portalClient,
  readJson,
  type RawRecord,
  type StreamSource,
} from "@ingestion/lib";
import { toLower, validateEthAddressList } from "@ingestion/lib/evm";
import {
  hyperliquidReplicaCmdsPortalStream,
  hyperliquidReplicaCmdsQuery,
  type replicaCmdsApi,
} from "@subsquid/pipes/hyperliquid";
import * as z from "zod";

const defaultPortalUrl = "https://portal.sqd.dev/datasets/hyperliquid-replica-cmds";

const env = z.object({
  PORTAL_URL: z.url().default(defaultPortalUrl),
  // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
  PORTAL_API_KEY: z.string().optional(),
  // Where the first run starts. Later runs resume after the cursor Pipes keeps in the warehouse.
  START_BLOCK: z.coerce.number().int().nonnegative(),
  // The last block to read, set only to check a short window. Unset, each run ends at Portal's finalized head.
  END_BLOCK: z.coerce.number().int().positive().optional(),
});

export type HypercoreActionsEnv = z.infer<typeof env>;

// Every action field but the signature, which no model reads and which would add bytes to every row. Typed
// over the SDK's ActionFields, a field that a Pipes upgrade adds fails the typecheck until it is listed here.
const actionFields: { [K in Exclude<keyof replicaCmdsApi.ActionFields, "signature">]-?: true } = {
  actionIndex: true,
  user: true,
  action: true,
  nonce: true,
  vaultAddress: true,
  status: true,
  response: true,
};

type Block = replicaCmdsApi.Block<{ block: { number: true; timestamp: true }; action: typeof actionFields }>;

const noUsers =
  "addresses.json lists no users. List at least one: HyperCore users send about 1.2 billion actions a day.";

/** The users in addresses.json, lowercased as Portal returns `user`. Unlike fills, the key is required. */
function users(addresses: Record<string, unknown>): string[] {
  if (!Object.hasOwn(addresses, "users")) throw new Error(noUsers);
  const values = addresses.users;
  if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) {
    throw new Error("addresses.json: users must be a list of addresses");
  }
  if (values.length === 0) throw new Error(noUsers);
  return validateEthAddressList(values).map(toLower);
}

// Each record is one action as Pipes returns it, unique by its block and its index in that block.
function blockRecords(block: Block): RawRecord[] {
  const timestamp = new Date(block.header.timestamp).toISOString();
  return block.actions.map((action) => {
    const id = `${block.header.number}:${action.actionIndex}`;
    return { id, callId: id, data: { block_number: block.header.number, timestamp, action } };
  });
}

/**
 * Every HyperCore action the users in addresses.json sent, from START_BLOCK to Portal's finalized head
 * when the run starts. Fields stay as Portal sends them: `action` and `response` are raw JSON, and
 * `response` is a plain string on some rejected actions. `vaultAddress` is null when the user acted for
 * itself. The dataset is not real-time: its finalized head trails hyperliquid-fills by about two hours.
 */
export const source: StreamSource<HypercoreActionsEnv> = {
  name: "hypercore",
  table: "actions",
  coverage: { defaultPortalUrl, filters: ["users"], unrestricted: [] },
  env,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const request = { user: users(readJson("addresses.json")) };
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, await finalizedHead(portal)) };
    const query = hyperliquidReplicaCmdsQuery()
      .addFields({ block: { number: true, timestamp: true }, action: actionFields })
      .addActionRequest({ range, request });

    return hyperliquidReplicaCmdsPortalStream({
      id: `${this.name}_${this.table}`,
      portal,
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: query.build().pipe((blocks) => blocks.flatMap(blockRecords)),
    });
  },
};
