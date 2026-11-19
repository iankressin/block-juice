# Sources

## Overview

One pnpm package per source. Each exports a `Source` (a call source) or a `StreamSource` (a stream source, read through Pipes) from `src/source.ts`, and `src/index.ts` runs it through `runSource` from `@ingestion/lib`. A package with a `chains/<chain>/` folder exports `forChain(chain)` and makes one source per chain folder, named for the chain. Dagster picks the chain through `CHAIN`. Each source reads the wallets, tokens or contracts it follows from its own `addresses.json` (or `tokens.json`) and loads `raw.<name>_<table>`. `evm-contract-deployments` reads no file and takes every create on the chain.

## Subdirectories & Boundaries

Call sources (state at a block or slot, or an off-chain API; failed calls become dead letters):

- binance-candles: [./binance-candles/README.md](./binance-candles/README.md) - Binance candles for the `tokens.json` markets, one call per window of up to 1000 candles, into `raw.binance_candles`.
- bitcoin-btc-balances: [./bitcoin-btc-balances/README.md](./bitcoin-btc-balances/README.md) - BTC balance of each listed wallet at the tip, from one `scantxoutset` call, into `raw.bitcoin_btc_balances`.
- coinbase-candles: [./coinbase-candles/README.md](./coinbase-candles/README.md) - Coinbase Exchange candles for the `tokens.json` markets, one call per 300-candle window, into `raw.coinbase_candles`.
- evm-account-state: [./evm-account-state/README.md](./evm-account-state/README.md) - Balance, nonce and code of each listed wallet at `BLOCK_NUMBER` and each `ALSO_AT_BLOCKS` block, into `raw.<chain>_account_state`.
- evm-address-code: [./evm-address-code/README.md](./evm-address-code/README.md) - `eth_getCode` for each listed address at one block, into `raw.<chain>_address_code`. The template for a new call source.
- evm-erc20-balances: [./evm-erc20-balances/README.md](./evm-erc20-balances/README.md) - `balanceOf` for every listed token and wallet at one block, into `raw.<chain>_erc20_balances`.
- evm-erc20-metadata: [./evm-erc20-metadata/README.md](./evm-erc20-metadata/README.md) - Name, symbol and decimals of each listed token, into `raw.<chain>_erc20_metadata`.
- evm-eth-balances: [./evm-eth-balances/README.md](./evm-eth-balances/README.md) - Native balance of each listed wallet at `BLOCK_NUMBER`, into `raw.<chain>_eth_balances`.
- polymarket-markets: [./polymarket-markets/README.md](./polymarket-markets/README.md) - Polymarket's market list from the Gamma API, open markets and then closed ones by UTC day, into `raw.polymarket_markets`.
- solana-sol-balances: [./solana-sol-balances/README.md](./solana-sol-balances/README.md) - SOL balance of each listed wallet at the latest finalized slot, into `raw.solana_sol_balances`.
- solana-spl-balances: [./solana-spl-balances/README.md](./solana-spl-balances/README.md) - Each listed wallet's balance of each listed mint, Token and Token-2022, into `raw.solana_spl_balances`.

Stream sources (logs, transactions, traces or fills from Portal; Pipes keeps the cursor in `raw._sync`):

- arbitrum-token-bridge: [./arbitrum-token-bridge/README.md](./arbitrum-token-bridge/README.md) - Arbitrum L2 gateway `DepositFinalized` and `WithdrawalInitiated` logs, into `raw.arbitrum_token_bridge`.
- evm-chainlink-price-feeds: [./evm-chainlink-price-feeds/README.md](./evm-chainlink-price-feeds/README.md) - `AnswerUpdated` logs of the listed Chainlink aggregators, into `raw.<chain>_chainlink_price_feeds`.
- evm-contract-deployments: [./evm-contract-deployments/README.md](./evm-contract-deployments/README.md) - Every transaction with a create trace, its create traces and the frames above them, and its state diffs, into `raw.<chain>_contract_deployments`.
- evm-cow-ethflow: [./evm-cow-ethflow/README.md](./evm-cow-ethflow/README.md) - CoW ETH Flow orders, their `createOrder` traces, transfers into listed wallets and same-transaction GPv2 `Trade` logs, into `raw.<chain>_cow_ethflow`.
- evm-erc20-transfers: [./evm-erc20-transfers/README.md](./evm-erc20-transfers/README.md) - ERC-20 `Transfer` logs of the listed tokens, optionally only those that touch listed wallets, into `raw.<chain>_erc20_transfers`.
- evm-op-standard-bridge: [./evm-op-standard-bridge/README.md](./evm-op-standard-bridge/README.md) - L2StandardBridge `ERC20BridgeInitiated` and `ERC20BridgeFinalized` logs for listed tokens on OP Stack chains, into `raw.<chain>_op_standard_bridge`.
- evm-uniswap-v2: [./evm-uniswap-v2/README.md](./evm-uniswap-v2/README.md) - `PairCreated` for listed tokens and the `Swap`s of those pairs, with their transactions, into `raw.<chain>_uniswap_v2`.
- evm-uniswap-v3: [./evm-uniswap-v3/README.md](./evm-uniswap-v3/README.md) - `PoolCreated` for listed tokens and the `Swap`s of those pools, with their transactions, into `raw.<chain>_uniswap_v3`.
- evm-uniswap-v4: [./evm-uniswap-v4/README.md](./evm-uniswap-v4/README.md) - PoolManager `Initialize` for listed tokens and the `Swap`s of those pool ids, with their transactions, into `raw.<chain>_uniswap_v4`.
- evm-wallet-transactions: [./evm-wallet-transactions/README.md](./evm-wallet-transactions/README.md) - Top-level transactions from or to listed wallets, with receipt fields, into `raw.<chain>_wallet_transactions`.
- hypercore-actions: [./hypercore-actions/README.md](./hypercore-actions/README.md) - Every HyperCore action the listed users sent, into `raw.hypercore_actions`.
- hypercore-fills: [./hypercore-fills/README.md](./hypercore-fills/README.md) - Every HyperCore fill of the listed users and coins, into `raw.hypercore_fills`.
- polygon-polymarket-ctf: [./polygon-polymarket-ctf/README.md](./polygon-polymarket-ctf/README.md) - The Polymarket CTF position ledger on Polygon, into `raw.polygon_polymarket_ctf`.
- polygon-polymarket-ctf-exchange-v2: [./polygon-polymarket-ctf-exchange-v2/README.md](./polygon-polymarket-ctf-exchange-v2/README.md) - Every `OrderFilled` of the CTF Exchange v2 contracts, or with `wallets` only the fills whose maker is listed, and each fill's transaction, into `raw.polygon_polymarket_ctf_exchange_v2`.

## Verification

- One package: `pnpm -C ingestion --filter @ingestion/<package> test`, then `pnpm -C ingestion typecheck`.
- After adding or renaming a source: `pnpm -C ingestion generate-sources`, then `uv run --project orchestration pytest orchestration/tests/test_sources_json.py`.
