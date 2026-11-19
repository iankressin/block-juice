# Marts

## Overview

The tables that questions read. Each folder is one pipeline: its name is a key in `PIPELINES` in `orchestration/pipeline/schedules.py`, and that pipeline's Dagster job builds `path:models/marts/<pipeline>` and everything upstream of it, ingestion included. Every pipeline runs on `0 6 * * *` once its schedule is turned on. The `daily` job, also on `0 6 * * *`, builds `path:models/marts` and everything upstream of it, every pipeline at once. Most marts union the per-chain and per-version intermediate models; some read other marts, a seed or a staging view. All build in the `analytics` schema (`DBT_SCHEMA`).

## Subdirectories & Boundaries

- accounts: [./accounts/README.md](./accounts/README.md) - `wallet_transactions`, `wallet_eth_outflows`, `account_states` and `address_attributions` on Ethereum. Reads `cow_ethflow_orders` from the cow pipeline.
- balances: [./balances/README.md](./balances/README.md) - `latest_balances`: the latest balance per wallet and asset on Ethereum, Solana and Bitcoin.
- bridges: [./bridges/README.md](./bridges/README.md) - `bridge_transfers` and the inferred withdrawal-to-deposit `bridge_pairs` across Arbitrum and Base.
- cow: [./cow/README.md](./cow/README.md) - `cow_ethflow_orders`: CoW ETH Flow orders with the settlement that filled each.
- deployments: [./deployments/README.md](./deployments/README.md) - `deployment_state_gas`: EIP-8037 state gas per deployment transaction, a lower bound.
- dex: [./dex/README.md](./dex/README.md) - `dex_trades`: one row per Uniswap v2, v3 or v4 `Swap` that traded.
- hypercore: [./hypercore/README.md](./hypercore/README.md) - `hypercore_fills` and `hypercore_actions` for the users you follow.
- labels: [./labels/README.md](./labels/README.md) - `address_labels`: the kind of each Arbitrum and Base address and the exchange that owns it.
- polymarket: [./polymarket/README.md](./polymarket/README.md) - Markets, trades, wallet fills, signed orders, 1-minute candles and per-wallet PnL.
- prices: [./prices/README.md](./prices/README.md) - `oracle_prices` (Chainlink rounds) and `token_prices` (Binance and Coinbase candles).
- tokens: [./tokens/README.md](./tokens/README.md) - `tokens`: the latest name, symbol and decimals per chain and token.
- transfers: [./transfers/README.md](./transfers/README.md) - `erc20_transfers`, `classified_transfers` and `labelled_wallet_flows`. Reads `wallet_transactions` and `address_labels` from other pipelines.

## Verification

- With a warehouse up: `uv run --project orchestration bj run <pipeline>`, or `--select <model>` for one mart. It runs the mart's tests too.
- `uv run --project orchestration pytest orchestration/tests/test_definitions.py` checks that every asset belongs to a scheduled pipeline.
