import { createPublicClient, http } from "viem";
import { createLimiter } from "#src/concurrency.ts";
import type { BlockNumber } from "#src/env.ts";

export type Chain = ReturnType<typeof createChain>;

export type ChainOptions = {
  maxConcurrency?: number;
  retryCount?: number;
  /** Most JSON-RPC calls per HTTP request. Providers cap this differently (drpc's free plan allows 3). */
  batchSize?: number;
};

/**
 * Every readContract call made in the same tick at the same blockNumber goes out as one
 * Multicall3 aggregate3 eth_call. Deployless mode sends the Multicall3 bytecode with the call,
 * so it works on any chain and at blocks before Multicall3 was deployed.
 *
 * Requests sent in the same tick, such as one eth_getBalance per wallet, go out as JSON-RPC
 * batches of up to `batchSize` calls per HTTP request.
 */
export function createChain(
  rpcUrl: string,
  { maxConcurrency = 16, retryCount = 5, batchSize = 100 }: ChainOptions = {},
) {
  const limit = createLimiter(maxConcurrency);

  return createPublicClient({
    transport: http(rpcUrl, {
      batch: { batchSize },
      retryCount,
      fetchFn: (input, init) => limit(() => fetch(input, init)),
    }),
    batch: { multicall: { deployless: true } },
  });
}

/**
 * A tag becomes the block it points to now. Calls carry that number, so every call in the
 * run reads the same block, and a call retried in a later run still reads the block it missed.
 */
export async function resolveBlock(chain: Chain, block: BlockNumber): Promise<number> {
  if (typeof block === "number") return block;
  const { number } = await chain.getBlock({ blockTag: block });
  return Number(number);
}
