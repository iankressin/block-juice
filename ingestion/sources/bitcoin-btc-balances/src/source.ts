import { retryPages, readJson, type Source } from "@ingestion/lib";
import {
  bitcoinEnv,
  createBitcoinClient,
  validateBitcoinAddressList,
  type BitcoinEnv,
} from "@ingestion/lib/bitcoin";
import {
  balanceCallSchema,
  balanceCalls,
  fetchBalances,
  type BalanceCall,
} from "#src/balances.ts";

// BTC balance of every wallet in addresses.json, plus the wallets that failed in earlier runs,
// at the chain tip.
export const bitcoinBtcBalances: Source<BitcoinEnv, BalanceCall> = {
  name: "bitcoin",
  table: "btc_balances",
  env: bitcoinEnv,
  call: balanceCallSchema,
  retryMode: "paged",
  async *extract(env, retry, context) {
    // Read inside the run, not at import, so runSource reports a bad addresses.json.
    const addresses = readJson("addresses.json");
    const wallets = validateBitcoinAddressList(addresses.wallets);
    const client = createBitcoinClient(env.DSHACKLE_URL);
    const selected = new Set(wallets);
    for await (const page of retryPages(retry, context)) for (const call of page) selected.add(call.wallet);
    // scantxoutset scans the entire UTXO set once and returns one shared height. Splitting
    // wallets would repeat that expensive scan and mix snapshots, so keep its native batch.
    yield await fetchBalances(client, balanceCalls([...selected]));
  },
};
