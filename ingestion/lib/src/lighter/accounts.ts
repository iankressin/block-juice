import * as z from "zod";
import { LighterError, type LighterClient } from "#src/lighter/client.ts";

export type AccountsFile = { accounts?: number[]; l1_addresses?: string[] };

const accountIndex = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const l1Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be an Ethereum address: 0x and 40 hex digits");

/** The shape of a source's `addresses.json`: account indexes, L1 addresses, or both, at least one entry in all. */
export const accountsFileSchema: z.ZodType<AccountsFile> = z
  .object({
    accounts: z.array(accountIndex).min(1).optional(),
    l1_addresses: z.array(l1Address).min(1).optional(),
  })
  .refine((file) => file.accounts !== undefined || file.l1_addresses !== undefined, {
    message: "addresses.json lists no accounts and no l1_addresses",
  });

const accountsByL1Reply = z.object({ sub_accounts: z.array(z.object({ index: z.number() })) });

/** Lighter's code for an L1 address it has no account for. */
const ACCOUNT_NOT_FOUND = 21100;

/** Listed indexes plus every sub-account of each listed L1 address, sorted, without repeats. */
export async function resolveAccounts(client: LighterClient, file: AccountsFile): Promise<number[]> {
  const indexes = new Set(file.accounts);
  for (const address of file.l1_addresses ?? []) {
    let reply: Record<string, unknown>;
    try {
      reply = await client.get("/api/v1/accountsByL1Address", { l1_address: address });
    } catch (error) {
      if (error instanceof LighterError && error.code === ACCOUNT_NOT_FOUND) {
        throw new Error(`addresses.json lists ${address}, but Lighter has no account for it`);
      }
      throw error;
    }
    for (const { index } of accountsByL1Reply.parse(reply).sub_accounts) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}
