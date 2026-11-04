import type { Source } from "@ingestion/lib";
import { connect, evmEnv, validateEthAddressList, type EvmEnv } from "@ingestion/lib/evm";
import {
  balanceCallSchema,
  balanceCallsAt,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

// Balance of every token for every wallet in addresses.json at BLOCK_NUMBER, plus the calls
// that failed in earlier runs, at their own blocks.
export const ethereumErc20Balances: Source<EvmEnv, BalanceCall> = {
  name: "ethereum",
  table: "erc20_balances",
  env: evmEnv,
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const { default: addresses } = await import("../addresses.json", { with: { type: "json" } });
    const wallets = validateEthAddressList(addresses.wallets);
    const tokens = validateEthAddressList(addresses.tokens);
    const { client, block } = await connect(env);
    yield await fetchBalances(client, [...balanceCallsAt(block, wallets, tokens), ...retry]);
  },
};
