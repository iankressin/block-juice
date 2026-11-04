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

const addresses = z.object({ wallets: z.array(solanaAddress), mints: z.array(solanaAddress) });

// Balance of every mint for every wallet in addresses.json, plus the calls that failed in
// earlier runs, at the latest finalized slot.
export const solanaSplBalances: Source<SolanaEnv, BalanceCall, z.infer<typeof addresses>> = {
  name: "solana",
  table: "spl_balances",
  env: solanaEnv,
  addresses,
  call: balanceCallSchema,
  async *extract(env, retry, { wallets, mints }) {
    // The free RPCs that serve getTokenAccountsByOwner allow about 2 calls a second
    // between them; sent all at once, most calls are refused.
    const rpc = createSolanaClient(env.ERPC_URL, { maxConcurrency: 2 });
    yield await fetchBalances(rpc, [...balanceCalls(wallets, mints), ...retry]);
  },
};
