import { chunk, portalClient, readJson, settleCalls, uniqueBy, type Batch, type Source } from "@ingestion/lib";
import {
  address,
  createEvmClient,
  evmEnv,
  toLower,
  validateEthAddressList,
  type EvmClient,
} from "@ingestion/lib/evm";
import type { PortalClient } from "@subsquid/pipes/portal-client";
import { BaseError, ContractFunctionZeroDataError, RawContractError, erc20Abi, type Address } from "viem";
import * as z from "zod";
import { boundaryBlock, finalizedHeadAt, midnight, midnights, portalHeaders } from "#src/boundary.ts";

const env = evmEnv
  .omit({ BLOCK_NUMBER: true })
  .extend({
    // The chain's Portal dataset, set in chains/<chain>/.env.example.
    PORTAL_URL: z.url(),
    // Sent with every Portal request when set. Without one, the public Portal answers at its anonymous limits.
    PORTAL_API_KEY: z.string().optional(),
    // The first UTC day whose starting midnight to read, YYYY-MM-DD.
    START_DATE: z.iso.date(),
    // The last such day. Unset, each run reads to the last midnight Portal's finalized head has passed.
    END_DATE: z.iso.date().optional(),
  })
  .refine((e) => e.END_DATE === undefined || e.START_DATE <= e.END_DATE, {
    message: "END_DATE must not be before START_DATE",
  });

export type SupplyEnv = z.infer<typeof env>;

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

export const supplyCallSchema = z.object({ kind: z.literal("erc20_supply"), midnight, token: address });

export type SupplyCall = z.infer<typeof supplyCallSchema>;

const callId = (call: SupplyCall) => `${call.midnight}:${call.token}`;

// Each call reads Portal about three times and the RPC once, so a few at once stay under public limits.
const CALLS_PER_BATCH = 5;

export const supplyCallsAt = (at: readonly string[], tokens: readonly Address[]): SupplyCall[] =>
  at.flatMap((m) => tokens.map((token) => ({ kind: "erc20_supply", midnight: m, token: toLower(token) })));

// A revert or an empty reply at a pinned block (e.g. the token was not deployed yet) gives the same
// answer on every retry, so it is a fact to record, not a failure to queue. viem raises these two errors
// only for one call's own result inside a Multicall3 batch, never for a failed batch request.
const revertedAtBlock = (error: unknown) =>
  error instanceof BaseError &&
  error.walk((e) => e instanceof RawContractError || e instanceof ContractFunctionZeroDataError) !== null;

async function readAt<F extends "totalSupply" | "decimals">(client: EvmClient, token: Address, functionName: F, block: number) {
  try {
    return await client.readContract({ address: token, abi: erc20Abi, functionName, blockNumber: BigInt(block) });
  } catch (error) {
    if (revertedAtBlock(error)) return null;

    throw error;
  }
}

/**
 * Each token's totalSupply() and decimals() at B - 1, the last block before the call's midnight, a few
 * calls a batch. B is the first block at or after the midnight by Portal's headers. Both reads of a call
 * start in one tick, so the client sends them as one Multicall3 call (see createEvmClient).
 */
export async function* readSupply(
  portal: PortalClient,
  client: EvmClient,
  head: number,
  calls: readonly SupplyCall[],
): AsyncIterable<Batch<SupplyCall>> {
  for (const group of chunk(uniqueBy(calls, callId), CALLS_PER_BATCH)) {
    yield await settleCalls(
      group,
      callId,
      async (call) => {
        const block = (await boundaryBlock(portal, portalHeaders(portal), head, call.midnight)) - 1;
        const [supply, decimals] = await Promise.all([
          readAt(client, call.token, "totalSupply", block),
          readAt(client, call.token, "decimals", block),
        ]);
        return {
          block_number: block,
          midnight: call.midnight,
          token: call.token,
          total_supply: supply === null ? null : supply.toString(),
          decimals,
        };
      },
      (call, data) => `${data.block_number}:${call.token}`,
    );
  }
}

/**
 * For each UTC midnight from START_DATE that Portal's finalized head has passed, up to END_DATE, the
 * supply and decimals of every token in chains/<chain>/addresses.json at the last block before it. Each
 * run reads every midnight again and writes the same ids. Past blocks need an archive RPC. The source
 * is named for its chain, so each chain loads into raw.<chain>_erc20_supply.
 */
export const forChain = (chain: string): Source<SupplyEnv, SupplyCall> => ({
  name: chainName.parse(chain),
  table: "erc20_supply",
  env,
  call: supplyCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const file = `chains/${chain}/addresses.json`;
    const list = readJson(file);
    if (!Array.isArray(list.tokens) || list.tokens.length === 0) throw new Error(`${file} lists no tokens`);
    const tokens = validateEthAddressList(list.tokens);
    const portal = portalClient(env.PORTAL_URL, env.PORTAL_API_KEY);
    const client = createEvmClient(env.EVM_RPC_URL, { batchSize: env.RPC_BATCH_SIZE, maxConcurrency: env.RPC_MAX_CONCURRENCY });
    const head = await finalizedHeadAt(portal);
    const calls = [...supplyCallsAt(midnights(env.START_DATE, env.END_DATE, head.time), tokens), ...retry];
    yield* readSupply(portal, client, head.block, calls);
  },
});
