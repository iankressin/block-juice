# Staging

## Overview

One folder per source name (the chain, for `evm-*` sources). Each folder declares its raw tables in `_<name>__sources.yml` and `_<name>__<table>__sources.yml` files (source `<name>`, schema `RAW_SCHEMA`) and builds one view per raw table and kind of record, `stg_<name>__<table>`, in `analytics`. The view for each further kind adds a suffix: `_transactions`, `_txs`, `_traces` or `_state_diffs`, as in `stg_ethereum__cow_ethflow_traces`. A view casts fields out of `data` and lowercases EVM addresses. It does no joins and applies no rules.

## Subdirectories & Boundaries

- arbitrum: [./arbitrum/README.md](./arbitrum/README.md) - Views over `raw.arbitrum_*`: ERC-20 transfers, address code, the token bridge, Chainlink feeds and ERC-20 metadata.
- base: [./base/README.md](./base/README.md) - Views over `raw.base_*`: ERC-20 transfers, address code, the OP standard bridge, Chainlink feeds and ERC-20 metadata.
- binance: [./binance/README.md](./binance/README.md) - `stg_binance__candles` over `raw.binance_candles`.
- bitcoin: [./bitcoin/README.md](./bitcoin/README.md) - `stg_bitcoin__btc_balances`, balances in satoshis, addresses kept as written.
- coinbase: [./coinbase/README.md](./coinbase/README.md) - `stg_coinbase__candles` over `raw.coinbase_candles`.
- ethereum: [./ethereum/README.md](./ethereum/README.md) - Views over 12 `raw.ethereum_*` tables. Tables that mix logs, transactions, traces or state diffs split into one view per kind of record.
- hypercore: [./hypercore/README.md](./hypercore/README.md) - `stg_hypercore__fills` and `stg_hypercore__actions`.
- polygon: [./polygon/README.md](./polygon/README.md) - The Polymarket CTF ledger and the CTF Exchange v2 fills and their transactions.
- polymarket: [./polymarket/README.md](./polymarket/README.md) - `stg_polymarket__markets`, one Gamma market per row, keyed by `market_id`.
- solana: [./solana/README.md](./solana/README.md) - `stg_solana__sol_balances` and `stg_solana__spl_balances`, keyed by slot, addresses kept as written.

## Invariants

- A dbt source's name and table equal the ingestion source's `name` and `table`, so Dagster links the asset `[<name>, <table>]` to its staging view (`orchestration/tests/test_sources_json.py`).
- Solana and Bitcoin addresses keep their case, since base58 is case-sensitive.

## Verification

- `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- `uv run --project orchestration pytest orchestration/tests/test_sources_json.py`
