# polygon-polymarket-ctf-exchange-v2

## Overview

A stream source that loads every `OrderFilled` of Polymarket's CTF Exchange v2 contracts on Polygon, as emitted, and the transaction behind each fill as a record of its own. A fill names its order only by hash; the transaction's `matchOrders` input holds the signed orders themselves (`catalog/protocols/polymarket/NOTES.md`, Q12). It loads into `raw.polygon_polymarket_ctf_exchange_v2`, which dbt reads through `transformation/models/staging/polygon/stg_polygon__polymarket_ctf_exchange_v2.sql` and `stg_polygon__polymarket_ctf_exchange_v2_txs.sql`. The ABI comes from `catalog/protocols/polymarket/abis/ctf-exchange-v2.json`.

## Interface

- `src/source.ts:polygonPolymarketCtfExchangeV2`: the `StreamSource<ExchangeEnv>` with `name` `polygon` and `table` `polymarket_ctf_exchange_v2`.
- `src/source.ts:ExchangeEnv`: `PORTAL_URL` (default the `polygon-mainnet` dataset), `PORTAL_API_KEY` (optional), `START_BLOCK`, `END_BLOCK` (optional).
- `src/index.ts`: runs `polygonPolymarketCtfExchangeV2` through `runSource`.
- `addresses.json`, checked by the zod schema `addresses`: `exchanges`, a non-empty list, and an optional non-empty `wallets` list.
- `.env.example` sets `PORTAL_URL` and `START_BLOCK`.

## Invariants

- With `wallets`, only the fills whose indexed `maker` is listed load.
- Each match emits one `OrderFilled` per maker order and one for the taker order, whose taker is the exchange itself. Both load; dbt keeps the right ones and works out side, price and fee. `OrdersMatched` and `FeeCharged` repeat the fills and are not loaded (`catalog/protocols/polymarket/NOTES.md`, Q3).
- A log record has id `<block>:<logIndex>`, `event` `ctf_exchange_v2.OrderFilled`, and `data` with `kind: "log"`, `block_number`, `timestamp`, `tx_hash`, `log_index`, `contract` and `args`.
- A transaction record has id `tx:<hash>` and `data` with `kind: "transaction"`, `block_number`, `timestamp`, `hash`, `from` and `to`. A `matchOrders` call adds `function: "matchOrders"` and its decoded `args`; any other call adds `function: null` and the raw `input` (`src/source.ts:transactionRecord`). Only the transactions of loaded fills are written.
- The range runs from `START_BLOCK` to `END_BLOCK` or Portal's finalized head at the start of the run, whichever comes first.
- `coverage.filters` is `exchanges` and `wallets`, with `wallets` unrestricted. A changed filter list or start block, or a set `SOURCE_BACKFILL_ID`, starts a new cursor that backfills from `START_BLOCK`, and a changed `PORTAL_URL` fails the run (`ingestion/lib/src/warehouse/provenance.ts`).
- An error fails the run, and the next run resumes after the last batch that committed. The source has no dead letters.

## Side Effects

- Streams from Portal at `PORTAL_URL`, sending `PORTAL_API_KEY` when set.
- `runSource` writes the records to `raw.polygon_polymarket_ctf_exchange_v2` (`id`, `data`, `_loaded_at`), records each configuration in `raw._source_configurations` and the blocks it loaded in `raw._coverage`, Pipes keeps the cursor in `raw._sync`, keyed by the raw table and its configuration generation (`ingestion/lib/src/warehouse/stream.ts:pipesTarget`), and the run goes in the run log, `ops.ingestion_runs`.
- Pushes run metrics to `PUSHGATEWAY_URL` when set.

## Verification

- Run: `pnpm -C ingestion --filter @ingestion/polygon-polymarket-ctf-exchange-v2 test`
- Run: `pnpm -C ingestion typecheck`
