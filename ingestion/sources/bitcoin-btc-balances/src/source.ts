import type { Source } from "@ingestion/lib";
import {
  bitcoinAddress,
  bitcoinEnv,
  createBitcoinClient,
  type BitcoinEnv,
} from "@ingestion/lib/bitcoin";
import * as z from "zod";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

const addresses = z.object({ wallets: z.array(bitcoinAddress) });

// BTC balance of every wallet in addresses.json, plus the wallets that failed in earlier runs,
// at the chain tip.
export const bitcoinBtcBalances: Source<BitcoinEnv, BalanceCall, z.infer<typeof addresses>> = {
  name: "bitcoin",
  table: "btc_balances",
  env: bitcoinEnv,
  addresses,
  call: balanceCallSchema,
  async *extract(env, retry, { wallets }) {
    const client = createBitcoinClient(env.DSHACKLE_URL);
    yield await fetchBalances(client, [...balanceCalls(wallets), ...retry]);
  },
};
