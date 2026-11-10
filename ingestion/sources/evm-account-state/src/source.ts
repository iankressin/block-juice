import { chunk, readJson, settleCalls, uniqueBy, type Source } from "@ingestion/lib";
import {
  address,
  connect,
  evmEnv,
  toLower,
  validateEthAddressList,
  type EvmClient,
} from "@ingestion/lib/evm";
import type { Address } from "viem";
import * as z from "zod";

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

const env = evmEnv.extend({
  // More blocks to read in every run besides BLOCK_NUMBER, comma-separated, such as the first block of
  // an answer's window. A reading already loaded is read again and replaces itself.
  ALSO_AT_BLOCKS: z
    .string()
    .regex(/^\d+(,\d+)*$/, "Expected block numbers separated by commas")
    .transform((s) => s.split(",").map(Number))
    .optional(),
});

export type AccountStateEnv = z.infer<typeof env>;

/** The three RPC methods this source calls, one call each per address and block. */
export const KINDS = ["balance", "nonce", "code"] as const;

export const stateCallSchema = z.object({
  kind: z.enum(KINDS),
  block: z.number().int().nonnegative(),
  address,
});

export type StateCall = z.infer<typeof stateCallSchema>;

const callId = (call: StateCall) => `${call.block}:${call.kind}:${call.address}`;

export const stateCallsAt = (block: number, addresses: readonly Address[]): StateCall[] =>
  addresses.flatMap((a) => KINDS.map((kind) => ({ kind, block, address: toLower(a) })));

/**
 * Each call's reply as the chain gave it, at the call's block: eth_getBalance in wei, eth_getTransactionCount,
 * or eth_getCode, "0x" for an address with none.
 */
export const fetchState = (client: EvmClient, calls: readonly StateCall[]) =>
  settleCalls(calls, callId, async (call) => {
    const at = { address: call.address, blockNumber: BigInt(call.block) };
    const base = { kind: call.kind, block_number: call.block, address: call.address };
    switch (call.kind) {
      case "balance":
        return { ...base, balance: await client.getBalance(at) };
      case "nonce":
        return { ...base, nonce: await client.getTransactionCount(at) };
      case "code":
        return { ...base, code: (await client.getCode(at)) ?? "0x" };
    }
  });

/**
 * The balance, nonce and code of every wallet in chains/<chain>/addresses.json at BLOCK_NUMBER and at each
 * block in ALSO_AT_BLOCKS, plus the calls that failed in earlier runs, at their own blocks. The source is
 * named for its chain, so each chain loads into raw.<chain>_account_state.
 */
export const forChain = (chain: string): Source<AccountStateEnv, StateCall> => ({
  name: chainName.parse(chain),
  table: "account_state",
  env,
  call: stateCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const path = `chains/${chain}/addresses.json`;
    const listed = readJson(path).wallets;
    if (!Array.isArray(listed) || listed.length === 0) throw new Error(`${path} lists no wallets`);
    const wallets = validateEthAddressList(listed);
    const { client, block } = await connect(env);
    const blocks = [...new Set([block, ...(env.ALSO_AT_BLOCKS ?? [])])];
    const calls = uniqueBy([...blocks.flatMap((b) => stateCallsAt(b, wallets)), ...retry], callId);
    // A request's timeout runs while it waits for a free slot, so a few thousand calls made at once time
    // out in the queue. Each chunk keeps about ten rounds of requests in flight, and is a batch of its own.
    for (const part of chunk(calls, env.RPC_BATCH_SIZE * env.RPC_MAX_CONCURRENCY * 10)) {
      yield await fetchState(client, part);
    }
  },
});
