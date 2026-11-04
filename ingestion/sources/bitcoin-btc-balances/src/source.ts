import type { Source } from "@ingestion/lib";
import * as z from "zod";
import { validateBitcoinAddressList } from "#src/address.ts";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

const bitcoinEnv = z.object({ DSHACKLE_URL: z.url() });

// BTC balance of every wallet in addresses.json, plus the wallets that failed in earlier runs,
// at the chain tip.
export const bitcoinBtcBalances: Source<z.infer<typeof bitcoinEnv>, BalanceCall> = {
  name: "bitcoin",
  table: "btc_balances",
  env: bitcoinEnv,
  call: balanceCallSchema,
  async *extract(env, retry) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const { default: addresses } = await import("../addresses.json", { with: { type: "json" } });
    const wallets = validateBitcoinAddressList(addresses.wallets);
    yield await fetchBalances(env.DSHACKLE_URL, [...balanceCalls(wallets), ...retry]);
  },
};
