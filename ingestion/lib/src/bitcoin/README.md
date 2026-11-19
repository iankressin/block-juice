# Bitcoin

## Overview

Bitcoin code for sources, imported as `@ingestion/lib/bitcoin`: a zod schema for mainnet addresses, the settings a Bitcoin source reads, and a JSON-RPC client that scans the UTXO set. Part of [`@ingestion/lib`](../../README.md).

## Interface

- `bitcoinAddress` (`address.ts`): a zod schema that accepts a mainnet P2PKH, P2SH, P2WPKH, P2WSH or P2TR address and outputs it encoded again, branded `BitcoinAddress`.
- `validateBitcoinAddressList(addresses)` (`address.ts`): returns the list as `BitcoinAddress[]`, or throws one error that lists every invalid address.
- `scriptPubKey(address)` (`address.ts`): the hex output script a payment to the address locks to. `scantxoutset` names each unspent by it.
- `bitcoinEnv` / `BitcoinEnv` (`env.ts`): `DSHACKLE_URL`, a URL.
- `createBitcoinClient(url)` / `BitcoinClient` (`client.ts`): one method, `scanTxOutSet(descriptors)`, which returns `{ height, unspents }`. Each unspent has `scriptPubKey` (hex) and `amount` (BTC).
- `index.ts` exports all of the above.
- `node-scripts.fixture.ts`: test data, not exported. One address of each type and the script Bitcoin Core's `validateaddress` gave for it.

## Invariants

- Addresses are mainnet only: `address.ts` decodes with `Address(NETWORK)`.
- The same wallet is always the same string. `bitcoinAddress` decodes and encodes again, so an uppercase bech32 address becomes lowercase.
- One `scanTxOutSet` call scans the whole UTXO set once, however many descriptors it gets.
- `scanTxOutSet` parses the reply with the zod schema `scanReply` and throws on an HTTP error status, a JSON-RPC `error` (message and code), or an aborted scan (`success: false`).
- `SCAN_TIMEOUT_MS` (5 minutes) aborts a scan. The client makes no retries; a failed scan goes to the caller.
- When `DSHACKLE_URL` is unset, `loadEnv` fills in a local proxy URL from `DSHACKLE_PORT` (`../env.ts:localEndpoints`).

## Side Effects

- `scanTxOutSet` sends one JSON-RPC `POST` with method `scantxoutset` and params `["start", descriptors]` through `observedFetch`, which counts it in the run's transport metrics.
- The address helpers and `bitcoinEnv`: none.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/lib test`
- Run: `pnpm -C ingestion typecheck`
