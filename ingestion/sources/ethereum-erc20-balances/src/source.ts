import type { Source } from "@ingestion/lib";
import { address, connect, evmEnv, type EvmEnv } from "@ingestion/lib/evm";
import * as z from "zod";
import {
  balanceCallSchema,
  balanceCallsAt,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

const addresses = z.object({ wallets: z.array(address), tokens: z.array(address) });

// Balance of every token for every wallet in addresses.json at BLOCK_NUMBER, plus the calls
// that failed in earlier runs, at their own blocks.
export const ethereumErc20Balances: Source<EvmEnv, BalanceCall, z.infer<typeof addresses>> = {
  name: "ethereum",
  table: "erc20_balances",
  env: evmEnv,
  addresses,
  call: balanceCallSchema,
  async *extract(env, retry, { wallets, tokens }) {
    const { client, block } = await connect(env);
    yield await fetchBalances(client, [...balanceCallsAt(block, wallets, tokens), ...retry]);
  },
};
