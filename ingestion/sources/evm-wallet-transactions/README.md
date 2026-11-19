# evm-wallet-transactions

## Overview

A stream source that loads the top-level transactions sent from or to the wallets listed in `addresses.json` on one EVM chain, each with its receipt's fields. Internal transfers, which only traces show, are not here. Each folder in `chains/<chain>/` is a source named for its chain, so the `ethereum` folder loads `raw.ethereum_wallet_transactions`. dbt reads it through `transformation/models/staging/ethereum/stg_ethereum__wallet_transactions.sql`. The fee is dbt's to work out.

## Interface

- `src/source.ts:forChain(chain)`: the `StreamSource<WalletTransactionsEnv>` for one chain, with `name` the chain and `table` `wallet_transactions`.
- `src/source.ts:transactionRecord(header, tx)`: turns one Portal transaction into a record.
- `src/source.ts:chainName`: zod check for a chain name (`^[a-z][a-z0-9]*$`).
- `src/source.ts:WalletTransactionsEnv`: `PORTAL_URL`, `PORTAL_API_KEY` (optional), `START_BLOCK`, `END_BLOCK` (optional).
- `src/index.ts`: runs `forChain(process.env.CHAIN)` through `runSource`. Dagster sets `CHAIN`; by hand, run `CHAIN=ethereum pnpm ingest`.
- `chains/<chain>/addresses.json`: `wallets`, a list of EVM addresses. `chains/ethereum/.env.example` sets `PORTAL_URL` and `START_BLOCK`.

## Invariants

- The run fails when `wallets` is missing or empty, since the stream would keep no transaction yet move the cursor past the blocks it read.
- The stream sends one transaction filter for `from` and one for `to`, since Portal ANDs the fields of one filter. A transaction between two listed wallets is written once: the record id is `tx:<hash>`, and `stream` drops a hash it has already seen in the block.
- A record's `data` holds `kind: "transaction"`, `block_number`, `block_hash`, `timestamp`, `transaction_index`, `hash`, `nonce`, `from`, `to`, `value`, `type`, `status`, `gas_used`, `gas_price`, `effective_gas_price`, `blob_gas_used`, `blob_gas_price`, `contract_address` and `sighash`, with `null` for a field Portal leaves out.
- The range runs from `START_BLOCK` to `END_BLOCK` or Portal's finalized head at the start of the run, whichever comes first.
- `coverage.filters` is `["wallets"]`, with nothing unrestricted. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- An error fails the run, and the next run resumes after the last batch that committed. The source has no dead letters.

## Side Effects

- Streams from Portal at `PORTAL_URL`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.<chain>_wallet_transactions` (`id`, `data`, `_loaded_at`), records each configuration in `raw._source_configurations` and the blocks it loaded in `raw._coverage`, Pipes keeps the cursor in `raw._sync`, keyed by the raw table and its configuration generation (`ingestion/lib/src/warehouse/stream.ts:pipesTarget`), and the run goes in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/evm-wallet-transactions test`
- Run: `pnpm -C ingestion typecheck`
