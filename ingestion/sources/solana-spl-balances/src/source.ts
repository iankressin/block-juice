import { callBatches, readJson, type Source } from "@ingestion/lib";
import {
  createSolanaClient,
  solanaEnv,
  validateSolanaAddressList,
  type SolanaEnv,
} from "@ingestion/lib/solana";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

// Balance of every mint for every wallet in addresses.json, plus the calls that failed in
// earlier runs, at the latest finalized slot.
export const solanaSplBalances: Source<SolanaEnv, BalanceCall> = {
  name: "solana",
  table: "spl_balances",
  env: solanaEnv,
  call: balanceCallSchema,
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson("addresses.json");
    const wallets = validateSolanaAddressList(addresses.wallets);
    const mints = validateSolanaAddressList(addresses.mints);
    // The free RPCs that serve getTokenAccountsByOwner allow about 2 calls a second
    // between them; sent all at once, most calls are refused.
    const rpc = createSolanaClient(env.SOLANA_RPC_URL, { maxConcurrency: 2 });
    const selectedWallets = new Set(wallets);
    const selectedMints = new Set(mints);
    function* fresh() {
      for (const mint of selectedMints) for (const wallet of selectedWallets) yield* balanceCalls([wallet], [mint]);
    }
    for await (const part of callBatches(fresh(), retry, (call) => `${call.mint}:${call.wallet}`,
      (call) => selectedWallets.has(call.wallet) && selectedMints.has(call.mint), context)) yield await fetchBalances(rpc, part);
  },
};
