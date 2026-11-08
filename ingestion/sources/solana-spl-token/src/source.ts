import assert from "node:assert/strict";
import { finalizedHead, logger, portalClient, readJson, type StreamSource } from "@ingestion/lib";
import { validateSolanaAddressList } from "@ingestion/lib/solana";
import type { PortalClient } from "@subsquid/pipes/portal-client";
import { solanaPortalStream, solanaQuery } from "@subsquid/pipes/solana";
import * as z from "zod";
import { FIELDS, slotRecords } from "#src/records.ts";

const splTokenEnv = z
  .object({
    // The Solana Portal dataset.
    PORTAL_URL: z.url(),
    // Sent with every Portal request when set. Without one, the public Portal answers at its
    // anonymous limits.
    PORTAL_API_KEY: z.string().optional(),
    // The first slot to read, named START_BLOCK as `bj coverage` reads it. Later runs resume after
    // the cursor.
    START_BLOCK: z.coerce.number().int().nonnegative(),
    // The last slot to read, set only to check a short window. Unset, each run ends at Portal's
    // finalized head.
    END_BLOCK: z.coerce.number().int().positive().optional(),
  })
  .refine((env) => env.END_BLOCK === undefined || env.START_BLOCK <= env.END_BLOCK, {
    message: "END_BLOCK must not be before START_BLOCK",
  });

export type SplTokenEnv = z.infer<typeof splTokenEnv>;

const addressesFile = z.strictObject({ mints: z.array(z.string()).min(1) });

/** The mints in addresses.json, exactly as written: Base58 is case-sensitive. */
export function readMints(path: string): string[] {
  const addresses = readJson(path);
  // A wallet filter would load part of each transaction's balances, and the models check every
  // tracked balance against the instructions that moved it.
  if (addresses !== null && typeof addresses === "object" && "wallets" in addresses) {
    throw new Error(
      `${path} lists wallets, but this source loads every holder of its mints: remove wallets`,
    );
  }
  const parsed = addressesFile.safeParse(addresses);
  if (!parsed.success) throw new Error(`${path} is invalid:\n${z.prettifyError(parsed.error)}`);
  return validateSolanaAddressList(parsed.data.mints);
}

/**
 * Fails unless `slot` has a block. Portal answers a range whose last slots were skipped with an
 * empty body, and Pipes' client then asks for that range again without end. A run's range ends at
 * the finalized head, which has a block, or at END_BLOCK, which this checks.
 */
async function checkProduced(portal: PortalClient, slot: number, head: number) {
  assert.ok(slot < head);
  const query = {
    type: "solana",
    fromBlock: slot,
    toBlock: head,
    includeAllBlocks: true,
    fields: { block: { number: true } },
  } as const;
  for await (const { blocks } of portal.getStream(query)) {
    const first = blocks[0];
    if (first === undefined) continue;
    if (first.header.number === slot) return;
    throw new Error(
      `END_BLOCK ${slot} was skipped and has no block: ` +
        `set it to one that has, such as ${first.header.number}`,
    );
  }
  assert.fail("the finalized head has a block");
}

// Every slot from START_BLOCK, and in each the transactions that change a balance of a mint in
// addresses.json: the transaction, those balances, and the SPL Token instructions that touch them.
// Which instructions move which amounts between which owners is dbt's to work out.
export const solanaSplToken: StreamSource<SplTokenEnv> = {
  name: "solana",
  table: "spl_token",
  env: splTokenEnv,
  async stream(env) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const mints = readMints("addresses.json");
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const head = await finalizedHead(portal);
    const range = { from: env.START_BLOCK, to: Math.min(env.END_BLOCK ?? Infinity, head) };
    if (range.to < head) await checkProduced(portal, range.to, head);
    // A balance of a mint has a pre side, a post side or both, and a request's filters must all
    // match, so each side gets its own request. Each brings its transaction and its instructions.
    const related = { transaction: true, transactionInstructions: true } as const;
    const query = solanaQuery()
      .addFields(FIELDS)
      .includeAllBlocks(range)
      .addTokenBalanceRequest({ range, request: { preMint: mints, ...related } })
      .addTokenBalanceRequest({ range, request: { postMint: mints, ...related } });
    const tracked = new Set(mints);

    return solanaPortalStream({
      id: `${this.name}_${this.table}`,
      // solanaPortalStream takes options, not a client: these are the ones lib's portalClient sets.
      portal: {
        url: env.PORTAL_URL,
        finalized: true,
        http: {
          retryAttempts: 10,
          headers: env.PORTAL_API_KEY ? { "x-api-key": env.PORTAL_API_KEY } : {},
        },
      },
      logger: logger.child({ source: this.name, table: this.table }),
      outputs: query,
    }).pipe((slots) => slots.flatMap((slot) => slotRecords(slot, tracked)));
  },
};
