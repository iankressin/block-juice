# Intermediate

## Overview

Joins and rules between staging and marts, one folder per pipeline. Most chains and protocol versions get their own model, in the shape its mart unions: `int_<chain>_<thing>` or `int_<chain>_<protocol>_<version>_<thing>`. Some break the pattern: `int_binance_token_prices` and `int_coinbase_token_prices` name an exchange, `int_polymarket_markets`, `int_polymarket_outcome_tokens` and `int_polymarket_wallet_ledger` name no chain, and `int_ethereum_cow_*` and `int_polygon_polymarket_ctf_conditions`, `_resolutions` and `_position_changes` name no version. `int_polymarket_wallet_ledger` joins other intermediate models rather than being a branch a mart unions. Sign rules, buy or sell, units and code kinds live here, so a wrong rule is fixed in SQL and rebuilt without fetching anything again. Intermediate models build views in `analytics`, except four Polymarket models, which are tables.

## Subdirectories & Boundaries

- accounts: [./accounts/README.md](./accounts/README.md) - Ethereum wallet transactions (with `fee_wei`) and pivoted account state reads. Ephemeral.
- balances: [./balances/README.md](./balances/README.md) - Balance readings per chain (Ethereum, Solana, Bitcoin) under an enforced contract.
- bridges: [./bridges/README.md](./bridges/README.md) - Arbitrum token bridge and Base OP standard bridge moves, with a `direction`.
- cow: [./cow/README.md](./cow/README.md) - CoW ETH Flow orders with their `order_uid`, GPv2 trades and transfers into followed wallets.
- deployments: [./deployments/README.md](./deployments/README.md) - EIP-8037 state gas per Ethereum deployment transaction.
- dex: [./dex/README.md](./dex/README.md) - Uniswap v2, v3 and v4 trades, one model per version, under an enforced contract.
- hypercore: [./hypercore/README.md](./hypercore/README.md) - HyperCore fills with `signed_size`, `notional` and `is_taker`. Ephemeral.
- labels: [./labels/README.md](./labels/README.md) - Latest code reading and `code_kind` per Arbitrum and Base address.
- polymarket: [./polymarket/README.md](./polymarket/README.md) - CTF Exchange v2 fills and signed orders, CTF position changes, conditions, resolutions, Gamma markets and the wallet ledger.
- prices: [./prices/README.md](./prices/README.md) - Chainlink rounds per chain and Binance and Coinbase candles.
- tokens: [./tokens/README.md](./tokens/README.md) - ERC-20 metadata readings per chain.
- transfers: [./transfers/README.md](./transfers/README.md) - ERC-20 `Transfer` logs per chain.

## Verification

- `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up: `uv run --project orchestration bj run <pipeline> --select <model>`. Select an intermediate model by name.
