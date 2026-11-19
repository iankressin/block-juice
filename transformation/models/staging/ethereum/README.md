# Ethereum staging

## Overview

Typed views over the twelve raw tables that the Ethereum sources load. Each view reads one raw table and one kind of record, casts its fields out of `data` and lowercases EVM addresses. Five raw tables hold more than one kind of record, told apart by `data ->> 'kind'`, so they get one view per kind. There are no joins and no rules here: those live in `models/intermediate/`.

## Interface

`_ethereum__sources.yml` declares the dbt source `ethereum` in schema `RAW_SCHEMA` (default `raw`). Each table's name is the ingestion source's `table`, and its identifier is the raw table `ethereum_<table>`.

### Balances, transfers, prices and tokens

| Model | Reads | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- |
| `stg_ethereum__eth_balances` | `raw.ethereum_eth_balances` | `evm-eth-balances` | wallet and block read | `int_ethereum_balances` | balances |
| `stg_ethereum__erc20_balances` | `raw.ethereum_erc20_balances` | `evm-erc20-balances` | wallet, token and block read | `int_ethereum_balances`, `macros/erc20_balance_pairs.sql` | balances |
| `stg_ethereum__erc20_transfers` | `raw.ethereum_erc20_transfers` | `evm-erc20-transfers` | Transfer log of a token in its `chains/ethereum/addresses.json`, into or out of one of its wallets | `int_ethereum_erc20_transfers` | transfers |
| `stg_ethereum__chainlink_price_feeds` | `raw.ethereum_chainlink_price_feeds` | `evm-chainlink-price-feeds` | `AnswerUpdated` log of an aggregator in its `addresses.json` | `int_ethereum_chainlink_prices` | prices |
| `stg_ethereum__erc20_metadata` | `raw.ethereum_erc20_metadata` | `evm-erc20-metadata` | token and block read | `int_ethereum_erc20_metadata` | tokens |

### Accounts

| Model | Reads | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- |
| `stg_ethereum__wallet_transactions` | `raw.ethereum_wallet_transactions` | `evm-wallet-transactions` | top-level transaction from or to a wallet in its `addresses.json`, with its receipt's fields | `int_ethereum_wallet_transactions` | accounts, transfers |
| `stg_ethereum__account_state` | `raw.ethereum_account_state` | `evm-account-state` | state read (`kind` `balance`, `nonce` or `code`) of one address at one block | `int_ethereum_account_states` | accounts |

### Uniswap: one raw table per version, logs and transactions in each

| Model | Reads | Kind | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- | --- |
| `stg_ethereum__uniswap_v2` | `raw.ethereum_uniswap_v2` | `log` | `evm-uniswap-v2` | `PairCreated` naming a token in its `addresses.json`, or `Swap` of such a pair | `int_ethereum_uniswap_v2_trades` | dex |
| `stg_ethereum__uniswap_v2_transactions` | `raw.ethereum_uniswap_v2` | `transaction` | `evm-uniswap-v2` | transaction a v2 log came from | `int_ethereum_uniswap_v2_trades` | dex |
| `stg_ethereum__uniswap_v3` | `raw.ethereum_uniswap_v3` | `log` | `evm-uniswap-v3` | `PoolCreated` naming a token in its `addresses.json`, or `Swap` of such a pool | `int_ethereum_uniswap_v3_trades` | dex |
| `stg_ethereum__uniswap_v3_transactions` | `raw.ethereum_uniswap_v3` | `transaction` | `evm-uniswap-v3` | transaction a v3 log came from | `int_ethereum_uniswap_v3_trades` | dex |
| `stg_ethereum__uniswap_v4` | `raw.ethereum_uniswap_v4` | `log` | `evm-uniswap-v4` | `Initialize` naming a token in its `addresses.json`, or `Swap` of such a pool, both from the PoolManager | `int_ethereum_uniswap_v4_trades` | dex |
| `stg_ethereum__uniswap_v4_transactions` | `raw.ethereum_uniswap_v4` | `transaction` | `evm-uniswap-v4` | transaction a v4 log came from | `int_ethereum_uniswap_v4_trades` | dex |

### Contract deployments and CoW ETH Flow

| Model | Reads | Kind | Loaded by | One row per | Read by | Pipeline |
| --- | --- | --- | --- | --- | --- | --- |
| `stg_ethereum__contract_deployments` | `raw.ethereum_contract_deployments` | `trace` | `evm-contract-deployments` | create trace, or a frame above one, of a transaction with at least one create or create2 trace | `int_ethereum_deployment_state_gas` | deployments |
| `stg_ethereum__contract_deployments_transactions` | `raw.ethereum_contract_deployments` | `transaction` | `evm-contract-deployments` | such a transaction | `int_ethereum_deployment_state_gas` | deployments |
| `stg_ethereum__contract_deployments_state_diffs` | `raw.ethereum_contract_deployments` | `state_diff` | `evm-contract-deployments` | state diff of such a transaction: one account field (`balance`, `nonce`, `code`) or one storage slot of one address | `int_ethereum_deployment_state_gas` | deployments |
| `stg_ethereum__cow_ethflow` | `raw.ethereum_cow_ethflow` | `log` | `evm-cow-ethflow` | ETH Flow `OrderPlacement` sent by a followed wallet, ERC-20 `Transfer` into one, or GPv2Settlement `Trade` in a transaction with such a Transfer | `int_ethereum_cow_ethflow_orders`, `int_ethereum_cow_trades`, `int_ethereum_cow_wallet_transfers` | cow, accounts |
| `stg_ethereum__cow_ethflow_traces` | `raw.ethereum_cow_ethflow` | `trace` | `evm-cow-ethflow` | `createOrder` call from a followed wallet to an ETH Flow contract | `int_ethereum_cow_ethflow_orders` | cow, accounts |

### Columns

Every view has `id` and `_loaded_at`. The other columns, as each `.sql` file selects them:

- `stg_ethereum__eth_balances`: `block_number`, `wallet`, `balance` (wei).
- `stg_ethereum__erc20_balances`: `block_number`, `wallet`, `token`, `balance` (base units; null when the call reverted, such as before the token existed).
- `stg_ethereum__erc20_transfers`: `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `token`, `from_address`, `to_address`, `value` (base units).
- `stg_ethereum__chainlink_price_feeds`: `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `aggregator`, `answer` (an integer in the feed's decimals), `aggregator_round_id`, `updated_at`.
- `stg_ethereum__erc20_metadata`: `block_number`, `token`, `name`, `symbol`, `decimals`.
- `stg_ethereum__wallet_transactions`: `block_number`, `block_hash`, `block_timestamp`, `transaction_index`, `tx_hash`, `nonce`, `from_address`, `to_address` (null for a contract creation), `value`, `tx_type`, `status` (1 success, 0 revert), `gas_used`, `gas_price`, `effective_gas_price`, `blob_gas_used`, `blob_gas_price`, `contract_address`, `sighash`. Amounts in wei.
- `stg_ethereum__account_state`: `kind`, `block_number`, `address`, `balance` (wei), `nonce`, `code` (`'0x'` when none). Only the column that `kind` names is set; the other two are null.
- `stg_ethereum__uniswap_v2`: `event`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `contract`; PairCreated: `token0`, `token1`, `pair`, `all_pairs_length` (the ABI's unnamed fourth argument, `_3`); Swap: `sender`, `amount0_in`, `amount1_in`, `amount0_out`, `amount1_out`, `to_address`.
- `stg_ethereum__uniswap_v3`: `event`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `contract`; PoolCreated: `token0`, `token1`, `fee`, `tick_spacing`, `pool`; Swap: `sender`, `recipient`, `amount0`, `amount1` (signed as the pool emitted them), `sqrt_price_x96`, `liquidity`, `tick`.
- `stg_ethereum__uniswap_v4`: `event`, `block_number`, `block_timestamp`, `tx_hash`, `log_index`, `contract`, `pool_id`, `fee`, `sqrt_price_x96`, `tick`; Initialize: `currency0`, `currency1`, `tick_spacing`, `hooks`; Swap: `sender`, `amount0`, `amount1` (signed as emitted), `liquidity`. A currency of `0x0000000000000000000000000000000000000000` is native ETH.
- `stg_ethereum__uniswap_v2_transactions`, `_v3_transactions`, `_v4_transactions`: `block_number`, `hash`, `from_address`. A log's `tx_hash` is its transaction's `hash`.
- `stg_ethereum__contract_deployments`: `block_number`, `block_timestamp`, `transaction_index`, `trace_type`, `trace_address` (integer array; the top frame is the empty array), `subtraces`, `error` (null when the frame did not fail); create traces: `create_from`, `create_value`, `create_address`, `create_code`; call traces: `call_from`, `call_to`, `call_type`, `call_sighash`.
- `stg_ethereum__contract_deployments_transactions`: `block_number`, `block_timestamp`, `transaction_index`, `hash`, `from_address`, `to_address` (null for a top-level creation), `sighash`, `transaction_type` (4 is EIP-7702), `status` (1 success), `gas_used`.
- `stg_ethereum__contract_deployments_state_diffs`: `block_number`, `transaction_index`, `address`, `key`, `is_storage`, `diff_kind`, `prev`, `next`. The three deployment views join on `block_number` and `transaction_index`.
- `stg_ethereum__cow_ethflow`: `block_number`, `block_hash`, `block_timestamp`, `tx_hash`, `transaction_index`, `log_index`, `contract`, `event`; OrderPlacement: `order_sender`, `order_sell_token`, `order_buy_token`, `order_receiver`, `order_sell_amount`, `order_buy_amount`, `order_valid_to`, `order_fee_amount`, `order_kind`, `order_partially_fillable`, `order_data`; Trade: `trade_owner`, `trade_sell_token`, `trade_buy_token`, `trade_sell_amount`, `trade_buy_amount`, `trade_fee_amount`, `trade_order_uid`; Transfer: `transfer_from`, `transfer_to`, `transfer_value` (the token is `contract`).
- `stg_ethereum__cow_ethflow_traces`: `block_number`, `block_timestamp`, `tx_hash`, `transaction_index`, `trace_address` (jsonb), `error`, `from_address`, `to_address`, `value` (wei), `sighash`, `input`, `output` (the GPv2 order hash; null when the call failed).

In the views that hold several events, each event fills the columns of its own arguments and leaves the others null.

## Invariants

- `id` is `unique` and `not_null` on each raw table (`_ethereum__sources.yml`) and on each view (`_ethereum__models.yml`).
- The source name and table name match the ingestion source's `name` and `table` (comment in `_ethereum__sources.yml`). Dagster keys the ingestion asset `[ethereum, <table>]`, the same key dbt gives the source, and that is how the two link.
- A view over a shared raw table filters on one `data ->> 'kind'`: `log` or `transaction` for the Uniswap tables, `trace`, `transaction` or `state_diff` for `contract_deployments`, `log` or `trace` for `cow_ethflow`.
- Every EVM address column goes through `lower()`. Amounts stay in base units or wei.
- `stg_ethereum__wallet_transactions`, `stg_ethereum__cow_ethflow*` and `stg_ethereum__contract_deployments_transactions` lowercase their transaction hashes. The Uniswap and ERC-20 views keep `tx_hash` and `hash` as Portal sent them, so each log matches its transaction on equal strings.
- Uniswap: `event` is in `accepted_values` `[PairCreated, Swap]` (v2), `[PoolCreated, Swap]` (v3) and `[Initialize, Swap]` (v4). Each log's `tx_hash` passes a `relationships` test to its version's `_transactions.hash`, which is `unique`. v4's `pool_id` is `not_null`.
- `stg_ethereum__wallet_transactions`: `tx_hash` is `unique`; `status` is in `[0, 1]`; `block_number`, `from_address`, `value`, `gas_used` and `effective_gas_price` are `not_null`.
- `stg_ethereum__account_state`: `kind` is in `[balance, nonce, code]`, and `block_number || ':' || kind || ':' || address` is `unique`: one read per address, kind and block.
- `stg_ethereum__cow_ethflow`: `event` is in `[OrderPlacement, Trade, Transfer]`; `block_number`, `tx_hash` and `contract` are `not_null`. `stg_ethereum__cow_ethflow_traces`: `tx_hash`, `from_address` and `to_address` are `not_null`.
- `stg_ethereum__contract_deployments`: `trace_type` is in `[create, call, suicide]`; `transaction_index` and `trace_address` are `not_null`. `_transactions`: `hash` is `unique`. `_state_diffs`: `diff_kind` is in `['+', '*', '-']`. Portal sends no `'='` rows, and the test fails if it starts to, since the deployment rules read existence from `'*'` and `'-'`. A storage slot's `'*'` can start from zero, so new slots come from `prev` and `next`, not from the kind.
- `stg_ethereum__chainlink_price_feeds`: a `relationships` test (severity `warn`) checks `aggregator` against the seed `chainlink_feeds`. An aggregator missing there drops its rounds out of `oracle_prices`.
- `stg_ethereum__erc20_metadata`: `name`, `symbol` and `decimals` are null when the call reverted or returned nothing at that block. Never assume 18 decimals.

## Side Effects

- A dbt build creates or replaces each model as a view in `DBT_SCHEMA` (`analytics`), since `dbt_project.yml` sets `staging: +materialized: view`. The views read the raw tables live and copy no rows.
- Nothing here writes to `RAW_SCHEMA`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- With a warehouse up, build one view and run its tests: `uv run --project orchestration bj run <pipeline> --select <model>`, with the pipeline from the tables above, such as `bj run dex --select stg_ethereum__uniswap_v3`.
- `transformation/tests/uniswap_swaps_have_their_pool.sql` reads the three Uniswap log views, and `transformation/tests/erc20_transfers_match_balances.sql` reads `stg_ethereum__erc20_balances` through `erc20_balance_pairs()`.
