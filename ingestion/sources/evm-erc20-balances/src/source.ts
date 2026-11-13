import { callBatches, readJson, type Source } from "@ingestion/lib";
import { connect, evmEnv, validateEthAddressList, type EvmEnv } from "@ingestion/lib/evm";
import * as z from "zod";
import {
  balanceCallSchema,
  balanceCallsAt,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

/** A chain name as SOURCES and the dbt sources spell it, such as `ethereum`. */
export const chainName = z.string().regex(/^[a-z][a-z0-9]*$/, "Expected a chain name such as ethereum");

/**
 * The balance of every token for every wallet in chains/<chain>/addresses.json at BLOCK_NUMBER, plus
 * the calls that failed in earlier runs, at their own blocks. The source is named for its chain, so
 * each chain loads into raw.<chain>_erc20_balances.
 */
export const forChain = (chain: string): Source<EvmEnv, BalanceCall> => ({
  name: chainName.parse(chain),
  table: "erc20_balances",
  env: evmEnv,
  call: balanceCallSchema,
  retryMode: "paged",
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson(`chains/${chain}/addresses.json`);
    const wallets = validateEthAddressList(addresses.wallets);
    const tokens = validateEthAddressList(addresses.tokens);
    const { client, block } = await connect(env);
    const selectedWallets = new Set(wallets.map((value) => value.toLowerCase()));
    const selectedTokens = new Set(tokens.map((value) => value.toLowerCase()));
    function* fresh() {
      for (const token of selectedTokens) for (const wallet of selectedWallets) {
        yield* balanceCallsAt(block, [wallet as typeof wallets[number]], [token as typeof tokens[number]]);
      }
    }
    for await (const part of callBatches(fresh(), retry,
      (call) => `${call.block}:${call.token}:${call.wallet}`,
      (call) => call.block === block && selectedWallets.has(call.wallet) && selectedTokens.has(call.token), context)) {
      yield await fetchBalances(client, part);
    }
  },
});
