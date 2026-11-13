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

// SOL balance of every wallet in addresses.json, plus the wallets that failed in earlier runs,
// at the latest finalized slot.
export const solanaSolBalances: Source<SolanaEnv, BalanceCall> = {
  name: "solana",
  table: "sol_balances",
  env: solanaEnv,
  call: balanceCallSchema,
  retryMode: "paged",
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson("addresses.json");
    const wallets = validateSolanaAddressList(addresses.wallets);
    const rpc = createSolanaClient(env.SOLANA_RPC_URL);
    const selected = new Set(wallets);
    function* fresh() { for (const wallet of selected) yield* balanceCalls([wallet]); }
    for await (const part of callBatches(fresh(), retry, (call) => call.wallet,
      (call) => selected.has(call.wallet), context)) yield await fetchBalances(rpc, part);
  },
};
