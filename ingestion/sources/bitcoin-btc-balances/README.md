# bitcoin-btc-balances

## Overview

A call source that reads the BTC balance of each wallet in `addresses.json` at the chain tip and loads it into `raw.bitcoin_btc_balances`. One `scantxoutset` call covers every wallet. dbt reads the table through `transformation/models/staging/bitcoin/stg_bitcoin__btc_balances.sql`.

## Interface

- `src/source.ts:bitcoinBtcBalances`: the `Source<BitcoinEnv, BalanceCall>` that `src/index.ts` runs through `runSource`. `name` is `bitcoin`, `table` is `btc_balances`, `retryMode` is `paged`.
- Settings (`bitcoinEnv` in `ingestion/lib/src/bitcoin/env.ts`): `DSHACKLE_URL`. Left empty, `loadEnv` fills in a local proxy URL from the root `DSHACKLE_PORT`, or port 8545 when that is unset (`ingestion/lib/src/env.ts`).
- `src/balances.ts:balanceCallSchema` and `BalanceCall`: a call is `{ kind: "btc_balance", wallet }`.
- `src/balances.ts:balanceCalls(wallets)`: one call per wallet.
- `src/balances.ts:fetchBalances(client, calls)`: makes one scan for all the calls and returns a batch.
- `addresses.json`: `wallets`, a list of Bitcoin addresses, checked by `validateBitcoinAddressList`.
- `.env.example`: the warehouse settings, `DSHACKLE_URL`, `PUSHGATEWAY_URL` and `LOG_LEVEL`.

## Invariants

- A node reads only the current UTXO set, so every run reads at the tip and a retried call reads the balance as it is now.
- The call id is the wallet alone. The record id is `<height>:<wallet>`, so each run keeps its own reading.
- Each record's `data` holds `block_number` (the height the scan read), `wallet` and `balance` in satoshis, as a decimal string. A wallet with no unspents gets 0.
- The listed wallets and the retried ones go in one scan, since the node scans the whole UTXO set once however many wallets it looks for, and splitting them would mix heights.
- Unspents are matched to wallets by `scriptPubKey`, not by the node's descriptor. An unspent that matches no wallet's script throws, since some balance would come out short.
- Any error in the scan fails every wallet's call, and each waits in `_dead_letters`.
- `addresses.json` is read inside `extract` with `readJson`, so a bad file fails the run with a logged reason. A file with no `wallets` key fails with a bare TypeError that names neither the file nor the key.

## Side Effects

- One `scantxoutset` JSON-RPC call to `DSHACKLE_URL` per run (`createBitcoinClient`), with a 5-minute timeout (`SCAN_TIMEOUT_MS` in `ingestion/lib/src/bitcoin/client.ts`).
- `runSource` writes the records to `raw.bitcoin_btc_balances`, failed calls to `raw._dead_letters`, one row per run to `raw._ingestion_inputs`, and records the run in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set, and logs through the pino `logger`.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/bitcoin-btc-balances test`
- Run: `pnpm -C ingestion typecheck`
