import {
  createEvmClient,
  evmEnv,
  resolveBlock,
  validateEthAddressList,
  type EvmEnv,
  type Source,
} from "@ingestion/lib";
import {
  balanceCallSchema,
  balanceCallsAt,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

// ETH balance of every wallet in addresses.json at BLOCK_NUMBER, plus the calls that
// failed in earlier runs, at their own blocks.
export const ethereumEthBalances: Source<EvmEnv, BalanceCall> = {
  name: "ethereum",
  table: "eth_balances",
  env: evmEnv,
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const { default: addresses } = await import("../addresses.json", { with: { type: "json" } });
    const wallets = validateEthAddressList(addresses.wallets);
    const client = createEvmClient(env.ERPC_URL, { batchSize: env.RPC_BATCH_SIZE });
    const block = await resolveBlock(client, env.BLOCK_NUMBER);
    yield await fetchBalances(client, [...balanceCallsAt(block, wallets), ...retry]);
  },
};
