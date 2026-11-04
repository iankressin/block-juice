import type { Source } from "@ingestion/lib";
import {
  createSolanaClient,
  solanaAddress,
  solanaEnv,
  type SolanaEnv,
} from "@ingestion/lib/solana";
import * as z from "zod";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

const addresses = z.object({ wallets: z.array(solanaAddress) });

// SOL balance of every wallet in addresses.json, plus the wallets that failed in earlier runs,
// at the latest finalized slot.
export const solanaSolBalances: Source<SolanaEnv, BalanceCall, z.infer<typeof addresses>> = {
  name: "solana",
  table: "sol_balances",
  env: solanaEnv,
  addresses,
  call: balanceCallSchema,
  async *extract(env, retry, { wallets }) {
    const rpc = createSolanaClient(env.ERPC_URL);
    yield await fetchBalances(rpc, [...balanceCalls(wallets), ...retry]);
  },
};
