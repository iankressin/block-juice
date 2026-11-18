# BlockJuice

[![CI](https://github.com/iankressin/block-juice/actions/workflows/ci.yml/badge.svg)](https://github.com/iankressin/block-juice/actions/workflows/ci.yml)

![BlockJuice, a blockchain data ELT framework](docs/images/bj-banner-2.png)

A self-hosted ELT framework and warehouse for blockchain data. You can trace any number it gives you back to raw rows, and rebuild it.

If you advise funds, treasuries or protocol teams, you know where on-chain work gets awkward. Explorers are fine for a quick look. Shared analytics platforms work until you need to own the query, the join or how long the data is kept.

BlockJuice runs in your environment. It loads chain data into your Postgres, transforms it with dbt and schedules the work with Dagster. Balances, transfers, trades and labels sit next to the rest of your data, under keys and policies you set.

The result is a pipeline an analyst can read, change and hand to a client. Every step is in the repo for anyone to check.

## Why

You keep the data. Raw rows, marts, run logs and answers live in a warehouse and repo you run. When an auditor or a client asks how a number was built, you can show them the model and the run that produced it.

You can ask in plain language. The repo's [Claude Code skill](#claude-code-skill) (`/bj <question>`) maps the question onto marts, and builds any that are missing. It runs the analysis through the `bj` CLI and writes `answers/<slug>/` with the value, the checks and the method. From there it can make a PDF, a spreadsheet or a Google Doc.

Adding coverage doesn't mean building a platform. For another wallet list, EVM chain or protocol, copy a source with `bj new-source`, regenerate `sources.json`, add the chain in dbt (see [transformation/README.md](transformation/README.md)) and schedule a pipeline. The [glossary](GLOSSARY.md) explains call sources and stream sources. The shared library already handles cursors and dead letters, so you can spend your time on the question.

When something breaks, you can see it. `bj doctor` checks your env and services before you start debugging. Grafana and the `ops.*` run log show ingestion and dbt side by side. The library keeps failed calls as dead letters instead of dropping them.

## Quick start

Try the [deterministic local demo](docs/demo.md) with `uv run --project orchestration bj demo` to build a small synthetic dataset and export its answer. For existing analyses, run `bj questions`; the [analysis authoring guide](docs/analysis-authoring.md) covers the complete workflow without an assistant.

You need Node 24 and [pnpm](https://pnpm.io) (both pinned in `mise.toml`), [uv](https://docs.astral.sh/uv/) and Docker.

First, set up the checkout:

```sh
uv run --project orchestration bj install
```

It copies each missing `.env` from its `.env.example`, installs the Node packages in `ingestion/` and runs `dbt parse`. It never overwrites an `.env` and starts nothing. `uv run` installs the Python packages before `bj` runs.

Then start everything:

```sh
uv run --project orchestration bj dev
```

`bj dev` does four things, in order:

1. Runs `bj install` again, which is safe to repeat.
2. Starts the Docker stack with `docker compose up -d`: the Postgres warehouse, eRPC, Dshackle, Prometheus, the Pushgateway and Grafana. It returns once the warehouse is set up.
3. Runs the `bj doctor` checks and stops if any of them fails.
4. Starts `dagster dev` in `orchestration/`, with `.env` loaded, at http://localhost:3000.

It stops at once if port 3000 is taken, since that usually means Dagster is already running. Ctrl-C stops Dagster and leaves the stack running. `docker compose down` stops the stack.

When Dagster is up, open http://localhost:3000, configure the sources for the wallets and tokens you need, and materialize the matching pipeline. For recurring runs, open **Automation → Schedules**, turn on that pipeline's schedule, and check its next tick. Schedules start stopped; a manual materialization does not enable them. Then ask a question with `/bj`, or read [Ask a question](docs/architecture.md#ask-a-question) for the `bj` commands behind it. If something looks wrong, run `bj doctor` before anything else.

New installs set `LOCAL_BIND_ADDRESS=127.0.0.1` in the root `.env`, keeping warehouse and RPC host ports local. Existing `.env` files without this setting retain their previous binding; add it to opt into loopback. Set `LOCAL_BIND_ADDRESS=0.0.0.0` when remote clients need access, with restricted network access and non-example credentials. See [Local setup](docs/architecture.md#local-setup-detail) for configuration and port changes.

To run all pipelines together, use `bj run daily` or enable `daily_schedule` in place of the individual schedules. The combined graph runs shared sources and models once. If one source fails, the shared dbt build is skipped. Keep individual schedules when pipelines need to refresh independently. [Scheduling and concurrency](docs/scheduling.md) explains the warehouse-wide budgets and how to switch an existing installation.

## What

Every table below lives in the `analytics` schema of your warehouse. A source reads only the wallets, tokens, feeds and contracts you list in its `addresses.json`, so each table covers the addresses you follow, not the whole chain. Every row traces back to the raw rows in `raw.<chain>_<table>` it was built from, such as `raw.ethereum_uniswap_v3`, and one Dagster job per pipeline rebuilds its tables each day at 06:00 UTC once you enable its schedule. `lighter` runs at 07:30 UTC, after its S3 files land (about 07:03 UTC). The `daily` job runs at 06:00 UTC and includes `lighter`, so under `daily` the S3 tables lag a day.

The grid shows which chains each table covers. Each section after it says what a row is, where it comes from, and lists the columns with their types.

| | Ethereum | Arbitrum | Base | Polygon | Solana | Bitcoin | HyperCore | Lighter | Binance, Coinbase |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| [Balances](#balances) | ✓ | | | | ✓ | ✓ | | | |
| [Transfers](#transfers) | ✓ | ✓ | ✓ | | | | | | |
| [DEX trades](#dex-trades) | ✓ | | | | | | | | |
| [Bridges](#bridges) | | ✓ | ✓ | | | | | | |
| [Labels](#labels) | | ✓ | ✓ | | | | | | |
| [Tokens](#tokens) | ✓ | ✓ | ✓ | | | | | | |
| [Exchange prices](#exchange-prices) | | | | | | | | | ✓ |
| [Oracle prices](#oracle-prices) | ✓ | ✓ | ✓ | | | | | | |
| [Polymarket](#polymarket) | | | | ✓ | | | | | |
| [HyperCore fills](#hypercore-fills) | | | | | | | ✓ | | |
| [HyperCore actions](#hypercore-actions) | | | | | | | ✓ | | |
| [Accounts](#accounts) | ✓ | | | | | | | | |
| [Deployments](#deployments) | ✓ | | | | | | | | |
| [CoW ETH Flow](#cow-eth-flow) | ✓ | | | | | | | | |
| [Lighter markets](#lighter-markets) | | | | | | | | ✓ | |
| [Lighter candles](#lighter-candles) | | | | | | | | ✓ | |
| [Lighter funding rates](#lighter-funding-rates) | | | | | | | | ✓ | |
| [Lighter exchange metrics](#lighter-exchange-metrics) | | | | | | | | ✓ | |
| [Lighter open interest](#lighter-open-interest) | | | | | | | | ✓ | |
| [Lighter trades](#lighter-trades) | | | | | | | | ✓ | |
| [Lighter account fills](#lighter-account-fills) | | | | | | | | ✓ | |
| [Lighter batches](#lighter-batches) | | | | | | | | ✓ | |
| [Lighter account movements](#lighter-account-movements) | | | | | | | | ✓ | |
| [Lighter account snapshots](#lighter-account-snapshots) | | | | | | | | ✓ | |
| [Lighter account value history](#lighter-account-value-history) | | | | | | | | ✓ | |

### Balances

`analytics.latest_balances`

Each wallet's latest balance of each asset, in the asset's base units: wei, lamports, satoshis or token units. One row per chain, wallet and asset. Covers ETH and ERC-20 on Ethereum, SOL and SPL on Solana, and BTC on Bitcoin.

The `balances` pipeline builds it from five call sources: `evm-eth-balances`, `evm-erc20-balances`, `solana-sol-balances`, `solana-spl-balances` and `bitcoin-btc-balances`.

| Column | Type | Description |
|---|---|---|
| `chain` | text | `ethereum`, `solana` or `bitcoin`. |
| `wallet` | text | The address whose balance was read. |
| `asset_type` | text | `native`, `erc20` or `spl`. |
| `asset` | text | `eth`, `sol` or `btc`, or the token or mint address. |
| `block_number` | bigint | The block, or Solana slot, the balance was read at. |
| `balance` | numeric | The amount in the asset's base units. |

### Transfers

`analytics.erc20_transfers`, `analytics.classified_transfers` and `analytics.labelled_wallet_flows`

Every ERC-20 transfer of the tokens you list, or only those into or out of your wallets. One row per Transfer log, in the token's base units. `classified_transfers` adds what kind of address each side is and sorts the transfer into a category: bridge, exchange, contract, p2p or unknown. Covers Ethereum, Arbitrum and Base. Classification reads [labels](#labels), which cover Arbitrum and Base.

The `transfers` pipeline builds both from the stream source `evm-erc20-transfers`, which reads Portal.

#### `erc20_transfers`

| Column | Type | Description |
|---|---|---|
| `chain` | text | `ethereum`, `arbitrum` or `base`. |
| `id` | text | The log's place on its chain, `<block>:<logIndex>`. Unique with `chain`. |
| `block_number` | bigint | The block the transfer was in. |
| `block_timestamp` | timestamptz | When that block was produced. |
| `tx_hash` | text | The transaction the log was in. |
| `log_index` | integer | The log's position in the block. |
| `token` | text | The token's contract address, lowercased. |
| `from_address` | text | The sender, lowercased. |
| `to_address` | text | The receiver, lowercased. |
| `value` | numeric | The amount in the token's base units. |

#### `classified_transfers`

Every column of `erc20_transfers`, and these:

| Column | Type | Description |
|---|---|---|
| `from_kind` | text | `exchange`, `deposit`, `contract`, `eoa`, `bridge` or `unknown`. |
| `from_exchange` | text | The exchange behind an exchange or deposit address. Else null. |
| `from_entity` | text | The exchange, `bridge:<chain>`, or the address itself. |
| `from_group` | text | The kind, with a deposit address counted as `exchange`. |
| `to_kind` | text | As `from_kind`, for the receiver. |
| `to_exchange` | text | As `from_exchange`, for the receiver. |
| `to_entity` | text | As `from_entity`, for the receiver. |
| `to_group` | text | As `from_group`, for the receiver. |
| `category` | text | `bridge`, `exchange`, `contract`, `p2p` or `unknown`. |

#### `labelled_wallet_flows`

One row per value movement that touches a wallet in `seeds/wallet_labels`, seen from the labelled entity's side. A movement is a successful top-level transaction with value from `wallet_transactions` (asset `native`, value in wei) or an ERC-20 Transfer from `erc20_transfers` (asset is the token's address). A movement between two entities comes once for each.

| Column | Type | Description |
|---|---|---|
| `chain` | text | The chain the movement was on. |
| `id` | text | The movement's id in its mart: `tx:<hash>` or `<block>:<logIndex>`. Unique with `chain` and `entity`. |
| `block_number` | bigint | The block the movement was in. |
| `asset` | text | `native`, or the token's address. |
| `value` | numeric | The amount, in wei or the token's base units. |
| `entity` | text | The labelled entity. |
| `wallet` | text | The entity's side of the movement, the sender for `intra`. |
| `direction` | text | `inflow`, `outflow` or `intra`. |
| `counterparty_address` | text | The other side. |
| `counterparty_entity` | text | The other side's entity; null when it has no label, or for `intra`. |

### DEX trades

`analytics.dex_trades`

One Uniswap swap: the token the swapper received and the token they paid, in each token's base units, with no decimals or prices applied. One row per Swap log. Covers Uniswap v2, v3 and v4 on Ethereum, for the pools that trade the tokens you list.

The `dex` pipeline builds it from the stream sources `evm-uniswap-v2`, `evm-uniswap-v3` and `evm-uniswap-v4`.

| Column | Type | Description |
|---|---|---|
| `id` | text | The Swap log's place on its chain, `<block>:<logIndex>`. |
| `chain` | text | `ethereum`. |
| `protocol` | text | `uniswap`. |
| `version` | text | `v2`, `v3` or `v4`. |
| `pool` | text | The pool's address, or its id in v4. |
| `block_number` | bigint | The block the swap was in. |
| `block_timestamp` | timestamptz | When that block was produced. |
| `tx_hash` | text | The transaction the log was in. |
| `log_index` | integer | The log's position in the block. |
| `tx_from` | text | Who signed the transaction. |
| `sender` | text | The pool's own sender field, often a router. |
| `recipient` | text | The pool's own recipient field. Null in v4. |
| `hooks` | text | The v4 pool's hooks contract. Null in v2 and v3. |
| `token_bought` | text | The token the swapper received. The zero address is native ETH. |
| `amount_bought` | numeric | How much of it, in base units. |
| `token_sold` | text | The token the swapper paid. |
| `amount_sold` | numeric | How much of it, in base units. |

### Bridges

`analytics.bridge_transfers` and `analytics.bridge_pairs`

One token move between an L2 and Ethereum through the chain's own bridge, in the token's base units. `direction` is `to_ethereum` for a withdrawal and `from_ethereum` for a deposit. `bridge_pairs` matches a withdrawal from one L2 with the deposit into another L2 it could have paid for: the same Ethereum address, token and amount, after the withdrawal chain's finality delay. The match uses amount and timing only. It does not read the Ethereum leg, which would prove it. Covers the Arbitrum token bridge and the OP Standard Bridge on Base, for the Ethereum tokens you list.

The `bridges` pipeline builds both from the stream sources `arbitrum-token-bridge` and `evm-op-standard-bridge`.

#### `bridge_transfers`

| Column | Type | Description |
|---|---|---|
| `chain` | text | `arbitrum` or `base`, the L2 the move was read on. |
| `id` | text | The log's place on its chain, `<block>:<logIndex>`. Unique with `chain`. |
| `direction` | text | `to_ethereum` for a withdrawal, `from_ethereum` for a deposit. |
| `l2_address` | text | The address on the L2 side. |
| `ethereum_address` | text | The address on the Ethereum side. |
| `ethereum_token` | text | The token's address on Ethereum. |
| `l2_token` | text | The token's address on the L2. |
| `amount` | numeric | The amount in the token's base units. |
| `block_number` | bigint | The block the move was in. |
| `block_timestamp` | timestamptz | When that block was produced. |
| `tx_hash` | text | The transaction the log was in. |
| `log_index` | integer | The log's position in the block. |

#### `bridge_pairs`

| Column | Type | Description |
|---|---|---|
| `from_chain` | text | The L2 the withdrawal left. |
| `from_address` | text | The address it left from. |
| `ethereum_address` | text | The Ethereum address both legs share. |
| `to_chain` | text | The L2 the deposit reached. |
| `to_address` | text | The address it reached. |
| `ethereum_token` | text | The Ethereum token both legs share. |
| `amount` | numeric | The amount both legs share, in base units. |
| `withdrawal_id` | text | The withdrawal's `id` in `bridge_transfers`. |
| `withdrawn_at` | timestamptz | When the withdrawal was made. |
| `withdrawal_tx_hash` | text | The withdrawal's transaction. |
| `deposit_id` | text | The deposit's `id` in `bridge_transfers`. |
| `deposited_at` | timestamptz | When the deposit was made. |
| `deposit_tx_hash` | text | The deposit's transaction. |
| `candidates` | bigint | How many withdrawals could have paid for the deposit. |

### Labels

`analytics.address_labels`

What kind of address each listed address is: `exchange` when the seed names it, `contract` when it has code, else `eoa`, which includes EIP-7702 delegations. One row per chain and address, with the exchange that owns it when one does. Covers Arbitrum and Base.

The `labels` pipeline builds it from the call source `evm-address-code`, which reads each address's code with `eth_getCode`, and the seed `transformation/seeds/cex_addresses.csv`.

| Column | Type | Description |
|---|---|---|
| `chain` | text | `arbitrum` or `base`. |
| `address` | text | The address, lowercased. |
| `code_block` | bigint | The block the code was read at. |
| `code_kind` | text | `contract`, `eip7702_delegation` or `none`. |
| `exchange` | text | The exchange that owns the address, from the seed. Else null. |
| `exchange_label` | text | The seed's label for the address, such as `Coinbase 1`. Else null. |
| `kind` | text | `exchange`, `contract` or `eoa`. |

### Tokens

`analytics.tokens`

Each listed token's latest `name`, `symbol` and `decimals`. One row per chain and token. Symbols repeat, so key on `chain` and `token`. A null `decimals` means the contract has none, so never assume 18. Covers ERC-20 tokens on Ethereum, Arbitrum and Base.

The `tokens` pipeline builds it from the call source `evm-erc20-metadata`.

| Column | Type | Description |
|---|---|---|
| `chain` | text | `ethereum`, `arbitrum` or `base`. |
| `token` | text | The token's contract address, lowercased. |
| `name` | text | What `name()` returned, with a `bytes32` reply decoded. Null when the call reverted. |
| `symbol` | text | What `symbol()` returned, decoded like `name`. Null when the call reverted. |
| `decimals` | integer | What `decimals()` returned. Null when the contract has none. |
| `block_number` | bigint | The block the reading was taken at. |

### Exchange prices

`analytics.token_prices`

One candle of one token against one quote asset at one interval, from one exchange. Prices are in quote-asset units and volume in token units. Covers Binance and Coinbase spot markets, for the pairs in each source's `tokens.json`. Binance serves intervals from `1m` to `1w`, Coinbase `1m`, `5m`, `15m`, `1h`, `6h` and `1d`.

The `prices` pipeline builds it from the call sources `binance-candles` and `coinbase-candles`, which read each exchange's public market-data API.

| Column | Type | Description |
|---|---|---|
| `exchange` | text | `binance` or `coinbase`. |
| `token` | text | The token's ticker on the exchange, such as `UNI`. |
| `quote` | text | The asset the prices are in, such as `USDT` or `USD`. |
| `interval` | text | The candle's length in Binance's names, such as `1h` or `1d`. |
| `open_time` | timestamptz | When the candle opened. |
| `close_time` | timestamptz | The candle's last millisecond. |
| `open` | numeric | The first trade's price, in quote-asset units. |
| `high` | numeric | The highest trade price. |
| `low` | numeric | The lowest trade price. |
| `close` | numeric | The last trade's price. |
| `volume` | numeric | How much of the token traded, in token units. |
| `quote_volume` | numeric | How much of the quote asset traded. Null for Coinbase. |
| `trades` | bigint | How many trades the candle holds. Null for Coinbase. |

### Oracle prices

`analytics.oracle_prices`

One round of one Chainlink price feed: the answer scaled by the feed's decimals into a price in quote units, with the round id the feed's proxy reports. One row per round. Covers Chainlink feeds on Ethereum, Arbitrum and Base, for the aggregators you list.

The `prices` pipeline builds it from the stream source `evm-chainlink-price-feeds` and the seed `transformation/seeds/chainlink_feeds.csv`, which names each aggregator's feed, proxy, phase, decimals and heartbeat.

| Column | Type | Description |
|---|---|---|
| `chain` | text | `ethereum`, `arbitrum` or `base`. |
| `oracle` | text | `chainlink`. |
| `id` | text | The log's place on its chain, `<block>:<logIndex>`. Unique with `chain`. |
| `feed` | text | The feed's name as its proxy describes it, such as `ETH / USD`. |
| `token` | text | The asset the feed prices, such as `ETH`. |
| `quote` | text | The asset the price is in, such as `USD`. |
| `proxy` | text | The address the feed is known by and that users read. |
| `aggregator` | text | The contract that stored the round and emitted its log. |
| `round_id` | numeric | The round's id as the proxy reports it. |
| `price` | numeric | The answer scaled by `decimals`, in quote units. |
| `answer` | numeric | The answer as the aggregator emitted it, an integer in the feed's decimals. |
| `decimals` | integer | How many decimals the feed's answer carries. |
| `updated_at` | timestamptz | When the aggregator stored the round. |
| `block_number` | bigint | The block the round's log was in. |
| `block_timestamp` | timestamptz | When that block was produced. |
| `tx_hash` | text | The transaction the log was in. |
| `log_index` | integer | The log's position in the block. |

### Polymarket

`analytics.polymarket_markets`, `analytics.polymarket_trades`, `analytics.polymarket_wallet_fills`, `analytics.polymarket_price_candles` and `analytics.polymarket_market_participants`

Polymarket's prediction markets on Polygon. A market is one condition in ConditionalTokens, with one outcome token per outcome. Once the market resolves, a share of each outcome redeems for that outcome's payout fraction in pUSD. Amounts are whole pUSD and whole shares, not base units. The `addresses.json` files list Polymarket's own contracts, so the tables cover every market, from the block the stream sources start at. A market prepared before that block has `history_complete` false, and its trades, candles and PnL miss what came before.

The `polymarket` pipeline builds all five from the call source `polymarket-markets`, which reads Polymarket's Gamma API for market names, and two stream sources that read Portal. `polygon-polymarket-ctf` loads each condition's preparation and resolution, and the splits, merges, redemptions and conversions of ConditionalTokens, the NegRiskAdapter, and the adapters and auto-redeemers in front of them. `polygon-polymarket-ctf-exchange-v2` loads every fill of the three CTF Exchange v2 contracts.

To follow specific wallets, list them under `wallets` in both stream sources' `addresses.json`. New runs load those wallets' fills, splits, merges, redemptions and conversions. Conditions and resolutions still load for every market. The trades and candles use maker fills, so taker-only trades by the selected wallets do not contribute. With wallet-scoped history, `history_complete` describes block coverage and open positions are valued at the tracked wallets' trade prices. Trust PnL on resolved markets only.

Changing the wallet list preserves previously loaded rows. If a warehouse previously tracked the whole market, its trades and candles still include other wallets' historical fills alongside the newly filtered data. For wallet-only marts, set the wallet lists before the first load into an empty `RAW_SCHEMA`, choose a separate `DBT_SCHEMA` for the models, and run the Polymarket pipeline over the desired window. Use `bj coverage` to inspect verified filters and ranges. See the [backfill instructions](docs/source-provenance.md#nondestructive-backfill) for untracked history.

#### `polymarket_markets`

One row per market.

| Column | Type | Description |
|---|---|---|
| `condition_id` | text | The market's condition in ConditionalTokens. Unique. |
| `market_id` | text | Gamma's market id. |
| `question` | text | Gamma's question. |
| `slug` | text | Gamma's slug for the market. |
| `event_id` | text | Gamma's event id. A neg-risk event holds several markets. |
| `event_title` | text | Gamma's title for the event. |
| `neg_risk` | boolean | True when the market belongs to a neg-risk event. |
| `protocol` | text | `ctf`, for markets that settle in ConditionalTokens. |
| `outcomes` | text[] | Gamma's outcome names, such as `Yes` and `No`. |
| `end_date` | timestamptz | When Gamma says the market ends. |
| `prepared_block` | bigint | The block of the condition's ConditionPreparation log. Null when that came before the start block. |
| `resolved_at` | timestamptz | When the condition resolved. Null until then. |
| `payout_fractions` | numeric[] | The pUSD one share of each outcome redeems for, in the order of `outcomes`. Null until resolved. |
| `history_complete` | boolean | True when the condition was prepared at or after the first block every Polymarket stream source loaded. Its trades, candles and PnL are then whole, unless the stream sources list `wallets`. |

#### `polymarket_trades`

One row per fill of a maker order. A match also logs the taker order's own fill, which repeats the same trade, so that one stays out.

| Column | Type | Description |
|---|---|---|
| `id` | text | The OrderFilled log's place on Polygon, `<block>:<logIndex>`. Unique. |
| `version` | text | `ctf_exchange_v2`. |
| `exchange` | text | The exchange contract that emitted the fill. |
| `block_number` | bigint | The block the fill was in. |
| `block_timestamp` | timestamptz | When that block was produced. |
| `tx_hash` | text | The transaction the log was in. |
| `log_index` | integer | The log's position in the block. |
| `condition_id` | text | The market the token belongs to. |
| `token_id` | numeric | The outcome token traded. |
| `outcome` | text | Gamma's name for the token's outcome. |
| `maker` | text | The maker order's owner: the proxy wallet or Safe that Polymarket shows as the trader. |
| `taker` | text | The taker order's owner. |
| `maker_side` | text | `buy` or `sell`, for the maker. |
| `shares` | numeric | Outcome tokens traded. |
| `usdc` | numeric | pUSD paid or received, before fees. |
| `price` | numeric | `usdc / shares`, in pUSD per share. |
| `fee_usdc` | numeric | The maker's fee, in pUSD. |

#### `polymarket_wallet_fills`

One row per fill per wallet: every OrderFilled, read for the wallet whose pUSD or shares moved, with its role in the match. Unlike `polymarket_trades`, which keeps maker fills only, it keeps the taker order's own fills too, so a wallet's taker fills count.

| Column | Type | Description |
|---|---|---|
| `id` | text | The OrderFilled log's key from the raw table. |
| `block_timestamp` | timestamptz | When that block was mined. |
| `tx_hash` | text | The transaction the fill was in. |
| `wallet` | text | The order's owner, the proxy wallet or Safe that Polymarket shows as the trader. |
| `role` | text | `taker` on the taker order's own fill; `maker` on every other fill, where the wallet's order rested on the book. |
| `counterparty` | text | The taker order's owner on a maker fill; null on a taker fill. |
| `condition_id` | text | The market the token belongs to; null when Gamma lacks the token. |
| `token_id` | numeric | The outcome token traded. |
| `side` | text | `buy` or `sell`, for the wallet. |
| `shares` | numeric | Outcome tokens traded. |
| `usdc` | numeric | pUSD paid or received, before fees. |
| `fee_usdc` | numeric | The wallet's fee in pUSD. |
| `price` | numeric | `usdc / shares`, in pUSD per share. |

#### `polymarket_price_candles`

One row per outcome token and minute, in pUSD per share. In a two-outcome market a trade of one outcome at a price also prices the other at 1 minus that price, so a token can have a candle in a minute it did not trade.

| Column | Type | Description |
|---|---|---|
| `token_id` | numeric | The outcome token. |
| `minute` | timestamptz | The minute the candle covers, from its start. |
| `condition_id` | text | The market the token belongs to. |
| `outcome` | text | Gamma's name for the token's outcome. |
| `open` | numeric | The minute's first price. |
| `high` | numeric | The minute's highest price. |
| `low` | numeric | The minute's lowest price. |
| `close` | numeric | The minute's last price. |
| `trades` | bigint | The token's own trades in the minute. 0 when only the other outcome traded. |
| `shares_volume` | numeric | Shares of the token traded in the minute. |
| `usdc_volume` | numeric | pUSD paid for them, before fees. |

#### `polymarket_market_participants`

One row per market and wallet: every wallet that traded, split, merged, redeemed or converted in the market. `pnl_usdc` is the cash the wallet got, after fees, plus what its shares are worth.

| Column | Type | Description |
|---|---|---|
| `condition_id` | text | The market. |
| `wallet` | text | The proxy wallet or Safe that Polymarket shows as the trader. |
| `trades` | bigint | The wallet's fills in the market, as the maker of either order. |
| `buy_usdc` | numeric | pUSD the wallet paid for shares, before fees. |
| `sell_usdc` | numeric | pUSD the wallet got for shares, before fees. |
| `fees_usdc` | numeric | Fees the wallet paid on its fills, in pUSD. |
| `net_cash_usdc` | numeric | Cash the wallet got less cash it paid, from trades, splits, merges, redemptions and conversions, after fees. |
| `open_shares` | numeric | Shares the wallet still holds, over all the market's outcomes. |
| `position_value_usdc` | numeric | What those shares are worth: each outcome's shares times its payout fraction once resolved, else the close of its last candle. Null when a held outcome has no price. |
| `pnl_usdc` | numeric | `net_cash_usdc + position_value_usdc`. Null when `position_value_usdc` is. |
| `first_activity_at` | timestamptz | The wallet's first move in the market. |
| `last_activity_at` | timestamptz | The wallet's last move in the market. |
| `resolved` | boolean | True when the market has resolved. |
| `history_complete` | boolean | The market's `history_complete`. When false, PnL misses what happened before the start block. |

### HyperCore fills

`analytics.hypercore_fills`

One user's side of one trade on Hyperliquid's HyperCore. The two sides of a trade are two rows that share `tid`. One row per fill. Prices and `notional` are in the coin's quote asset, which may not be USD. Sizes are in units of the coin, and fees are in `fee_token`. Covers only the users and coins listed in `ingestion/sources/hypercore-fills/addresses.json`.

The `hypercore` pipeline builds it from the stream source `hypercore-fills`, which reads Portal.

| Column | Type | Description |
|---|---|---|
| `id` | text | The fill's place on HyperCore, `<block>:<fillIndex>`. Unique. |
| `block_number` | bigint | The block the fill was in. |
| `block_timestamp` | timestamptz | When that block was produced. |
| `fill_time` | timestamptz | The fill's own time. |
| `fill_index` | integer | The fill's position in the block. |
| `tx_hash` | text | The action that made the trade. One action can make several trades. |
| `tid` | bigint | The trade. Both of its sides share it. |
| `oid` | bigint | The user's order. One order can fill in several trades. |
| `cloid` | text | The user's own id for the order. Null when unset. |
| `twap_id` | bigint | The TWAP order the fill belongs to. Null when unset. |
| `user_address` | text | The user whose side this is, lowercased. |
| `coin` | text | The coin as HyperCore spells it, such as `ZEC` or `xyz:SNDK`. |
| `side` | text | `B` for a buy, `A` for a sell, for the user. |
| `dir` | text | What the fill did to the user's position, such as `Open Long` or `Close Short`. |
| `px` | numeric | The price, in the quote asset per coin. |
| `sz` | numeric | How much of the coin traded. |
| `signed_size` | numeric | `sz` for a buy, `-sz` for a sell. |
| `notional` | numeric | `px * sz`, in the quote asset. |
| `is_taker` | boolean | True on the taker's side of the trade. |
| `start_position` | numeric | The user's position in the coin before the fill. Negative is short. |
| `closed_pnl` | numeric | The profit or loss the fill realized by closing a position. |
| `fee` | numeric | What the user paid, in `fee_token`. Negative is a rebate. |
| `fee_token` | text | The token the fee is in, such as `USDC`. |
| `builder` | text | The builder address on the order, lowercased. Null when none. |
| `builder_fee` | numeric | The builder's fee. The data does not show whether `fee` includes it. |

### HyperCore actions

`analytics.hypercore_actions`

One signed action a user sent to Hyperliquid's HyperCore: an order, a cancel, a modify, a leverage change, a transfer and the rest, accepted or rejected. One row per action. The payload and the L1's response stay as JSON. Orders name assets by number, not by coin. Covers only the users listed in `ingestion/sources/hypercore-actions/addresses.json`, which must list at least one.

The `hypercore` pipeline builds it from the stream source `hypercore-actions`, which reads Portal. Portal serves actions about two hours behind fills.

| Column | Type | Description |
|---|---|---|
| `id` | text | The action's place on HyperCore, `<block>:<actionIndex>`. Unique. |
| `block_number` | bigint | The block the action was in. |
| `block_timestamp` | timestamptz | When that block was produced. |
| `action_index` | integer | The action's position in the block. |
| `user_address` | text | The user who sent the action, lowercased. |
| `vault_address` | text | The vault the user acted for, lowercased. Null when the user acted for itself. |
| `action_type` | text | The kind of action, such as `order`, `cancelByCloid`, `batchModify` or `usdSend`. |
| `action` | jsonb | The action as the user signed it. Its keys depend on `action_type`. |
| `status` | text | `ok` or `err`, for the action as a whole. An `ok` action can still fail item by item. |
| `response` | jsonb | The L1's answer, with per-item results. An object on most actions, a JSON string on some rejected ones. |
| `nonce` | bigint | A time in milliseconds that the signer picks. |

### Lighter markets

`analytics.lighter_markets`

One Lighter market, perp or spot, with its decimals, fees and minimums as of the latest run. One row per market. Covers every market Lighter lists, about 257 today.

The `lighter` pipeline builds it from the call source `lighter-markets`, which reads Lighter's API. It runs daily at 07:30 UTC.

| Column | Type | Description |
|---|---|---|
| `market_id` | integer | The market's public id in Lighter's API. Unique. Join on this, not on `symbol`, which two markets can share. |
| `symbol` | text | The market's name, such as `ETH` or `ETH/USDC`. |
| `market_type` | text | `perp` or `spot`. |
| `base_asset_id` | integer | The base asset's id. |
| `quote_asset_id` | integer | The quote asset's id. |
| `status` | text | The market's state, such as `active`. |
| `size_decimals` | integer | Decimal places in an integer size of this market. |
| `price_decimals` | integer | Decimal places in an integer price of this market. |
| `quote_decimals` | integer | Decimal places in a quote amount of this market. |
| `maker_fee_pct` | numeric | The maker fee in percent, as Lighter sends it. |
| `taker_fee_pct` | numeric | The taker fee in percent, as Lighter sends it. |
| `min_base_amount` | text | The smallest order, in the base asset. |
| `min_quote_amount` | text | The smallest order, in the quote asset. |
| `created_at` | timestamptz | When Lighter listed the market. |
| `read_at` | timestamptz | When the run read these settings. |

### Lighter candles

`analytics.lighter_candles`

One Lighter candle per market, price series and bucket. `price` is `trade` for traded prices or `mark` for mark prices. Only closed candles load. Covers the markets in `markets.json` (ETH and BTC to start), from `START_TIME`.

The `lighter` pipeline builds it from the call source `lighter-candles`, which reads Lighter's API in windows of 500 candles. It runs daily at 07:30 UTC.

| Column | Type | Description |
|---|---|---|
| `market_id` | integer | The market's public id in Lighter's API. Join on this, not on `symbol`. |
| `symbol` | text | The market's name, such as `ETH`. |
| `price` | text | `trade` or `mark`. |
| `resolution` | text | The candle length, such as `1h`. |
| `open_time` | timestamptz | The start of the bucket. |
| `open`, `high`, `low`, `close` | numeric | Prices in USDC per base unit. |
| `base_volume` | numeric | Volume in base units. Null on a mark candle. A trade candle with no trades is 0. |
| `quote_volume` | numeric | Volume in USDC. Null on a mark candle. |
| `last_trade_id` | bigint | The last trade id in the bucket. Null on a mark candle. |
| `samples` | bigint | How many mark-price samples the bucket holds. Null on a trade candle. |

### Lighter funding rates

`analytics.lighter_funding_rates`

One hourly funding rate per Lighter perp market. An entry loads once its hour mark has passed. Covers the perp markets in `markets.json` (ETH and BTC to start), from `START_TIME`. A spot market in `markets.json` fails the run, since spot markets have no funding.

The `lighter` pipeline builds it from the call source `lighter-fundings`, which reads Lighter's API in windows of 750 hours. It runs daily at 07:30 UTC.

| Column | Type | Description |
|---|---|---|
| `id` | text | `<market_id>:<unix seconds of the hour>`. Unique. |
| `market_id` | integer | The market's public id in Lighter's API. Join on this, not on `symbol`. |
| `symbol` | text | The market's name, such as `ETH`. |
| `funding_time` | timestamptz | The hour mark the rate is paid at. |
| `rate_pct` | numeric | The rate in percent per hour, unsigned, as Lighter sends it. A rate can be 0. |
| `signed_rate_pct` | numeric | `rate_pct` for `long`, `-rate_pct` for `short`. Positive means longs pay shorts. The paying side is inferred from the funding page's rule; see `catalog/vendors/lighter/NOTES.md`. |
| `value_usdc_per_unit` | numeric | USDC paid per one unit of base for the hour. |
| `direction` | text | `long` for a positive rate, `short` for a negative one. |

### Lighter exchange metrics

`analytics.lighter_exchange_metrics`

One daily point per Lighter metric, as a long table. Exchange-wide kinds cover Lighter as a whole. Ten kinds also load per market, for the symbols in `markets.json` (ETH to start). Only ended UTC days load, so today waits for the next run. Each run reads every series again.

The `lighter` pipeline builds it from the call source `lighter-exchange-metrics`, which reads Lighter's API. It runs daily at 07:30 UTC.

| Column | Type | Description |
|---|---|---|
| `id` | text | `<kind>:<market or all>:<unix seconds of the day>`. Unique. |
| `day` | date | The UTC day the point covers. |
| `kind` | text | The metric: `volume`, `maker_fee`, `taker_fee`, `liquidation_fee`, `trade_count`, `liquidation_count`, `liquidation_volume`, `open_interest`, `attribution_maker_fee`, `attribution_taker_fee`, `account_count`, `active_account_count`, `inflow`, `outflow`, `transfer_fee`, `withdraw_fee`, `buyback` (from 2025-12-30) or `buyback_usdc`. |
| `market` | text | The symbol for a per-market series. Null for an exchange-wide one, and always null for the last eight kinds. |
| `value` | numeric | USDC for volumes, fees, flows and `open_interest`; LIT for `buyback`; a count for the rest. Only `volume`, the maker, taker and liquidation fees, `trade_count`, `liquidation_count` and ETH's `liquidation_volume` are proven; see `catalog/vendors/lighter/NOTES.md`. |

### Lighter open interest

`analytics.lighter_open_interest`

One end-of-hour open interest reading per Lighter market, about 5,000 rows a day. Lighter names the market by symbol only, so there is no `market_id`. Covers every market, from `START_DATE`. Only ended UTC days load: a day's file appears about 07:03 UTC the next day.

The `lighter` pipeline builds it from the call source `lighter-open-interest`, which reads Lighter's public S3 files, one day at a time, and skips a day it has loaded. After the framework parks a day's dead letter (five failed runs), the day reloads only when its file changes. It runs daily at 07:30 UTC.

| Column | Type | Description |
|---|---|---|
| `id` | text | `<symbol>:<hour>`. Unique. |
| `hour` | timestamptz | The start of the hour the reading closes. |
| `symbol` | text | The market's symbol. |
| `open_interest` | numeric | Open interest in base units. |
| `mark_price` | numeric | The mark price at the end of the hour. |
| `open_interest_usd` | numeric | `open_interest` times `mark_price`, in USDC. |

### Lighter trades

`analytics.lighter_trades`

One Lighter trade, in real units. One row per trade. Covers the accounts and markets in `ingestion/sources/lighter-trades/addresses.json` (account 313004 in ETH to start), from `START_DATE`. With both keys it takes the listed accounts' trades in the listed markets; with one, it takes all of that one. Only ended UTC days load: a day's file appears about 07:03 UTC the next day.

The `lighter` pipeline builds it from the call source `lighter-trades`, which reads Lighter's public S3 files, one day at a time, and skips a day it has loaded. A day holds 2 to 8 million trades, so `addresses.json` must list some accounts or markets. A changed `addresses.json` loads every day again. After the framework parks a day's dead letter (five failed runs), the day reloads only when its file changes. It runs daily at 07:30 UTC.

| Column | Type | Description |
|---|---|---|
| `trade_id` | bigint | Lighter's trade id. Unique. |
| `trade_time` | timestamptz | The block time of the trade. |
| `block_number` | bigint | The L2 block that holds the trade. |
| `tx_hash` | text | The transaction that made the trade. |
| `trade_type` | text | `trade`, `liquidation`, `deleverage` or `market-settlement`. |
| `market_id` | integer | The market's public id in Lighter's API. Join on this. |
| `slot_market_id` | integer | The file's own market id, a slot Lighter reuses for later markets. Never join on it. |
| `symbol` | text | The market's name, such as `ETH`. Null for a binary option. |
| `market_type` | text | `perp` or `spot`. Null for a binary option. |
| `price` | numeric | USDC per base unit. Null for a binary option. |
| `size` | numeric | Base units. Null for a binary option. |
| `price_raw`, `size_raw` | bigint | The price and size as the file holds them, before the market's decimals. |
| `notional_usdc` | numeric | The trade value in USDC, `usdc_amount / 10^6`. Set for a binary option, whose `size` and `price` are null. |
| `is_maker_ask` | boolean | True when the maker sold. |
| `maker_account_index` | bigint | The maker's account. |
| `taker_account_index` | bigint | The taker's account. |
| `taker_side` | text | `buy` or `sell`, for the taker. |
| `ask_account_index` | bigint | The seller's account. 281474976710655 means no account. |
| `bid_account_index` | bigint | The buyer's account. |
| `maker_fee_ppm`, `taker_fee_ppm` | integer | Each side's fee, in parts per million of notional. |
| `maker_fee_usdc`, `taker_fee_usdc` | numeric | Each side's fee, in USDC. |
| `integrator_maker_fee_usdc`, `integrator_taker_fee_usdc` | numeric | Each side's integrator fee, in USDC. |
| `ask_order_index`, `bid_order_index` | bigint | The sell and buy orders. |
| `maker_position_before`, `taker_position_before` | numeric | Each side's position before the trade, in base units. Negative is short. |
| `maker_entry_quote_before_usdc`, `taker_entry_quote_before_usdc` | numeric | The entry value of each side's position before the trade, in USDC. |
| `maker_position_sign_changed`, `taker_position_sign_changed` | boolean | True when the trade changed the sign of that side's position. Opening from 0 sets it, as on trade 40627877458. |
| `ask_account_pnl`, `bid_account_pnl` | numeric | The pnl the trade realized for the seller and the buyer, in USDC. Null when none. |

### Lighter account fills

`analytics.lighter_account_fills`

One fill per account and trade: each Lighter trade gives its maker one row and its taker one row, with the account's position before and after. A side with no account (281474976710655, on market-settlement trades) has no row. Covers the trades in `lighter_trades`, so the same markets and days, with both accounts of each loaded trade, counterparties included.

The `lighter` pipeline builds it from `lighter_trades`' source. Two tests check it against other data. `lighter_trades_within_candle_range` fails when a trade's price lies outside its hour's `lighter_candles` range. `lighter_account_fills_positions_chain` warns when an account's `position_before` differs from its previous fill's `position_after`, and it warns for every account whose history is only partly loaded, such as any counterparty of a filtered load, so it warns on thousands of rows. A break for an account whose history you loaded whole is the signal to look for.

| Column | Type | Description |
|---|---|---|
| `id` | text | `<trade_id>:<role>`. Unique. |
| `trade_id` | bigint | Lighter's trade id. |
| `trade_time` | timestamptz | The block time of the trade. |
| `market_id` | integer | The market's public id in Lighter's API. Join on this. |
| `symbol` | text | The market's name. Null for a binary option. |
| `account_index` | bigint | The account that made this side of the trade. |
| `role` | text | `maker` or `taker`. |
| `side` | text | `sell` for the ask account, `buy` for the bid account. |
| `signed_size` | numeric | Base units, positive for a buy and negative for a sell. Null for a binary option. |
| `price` | numeric | USDC per base unit. Null for a binary option. |
| `notional_usdc` | numeric | The trade's value in USDC. |
| `fee_ppm` | integer | The fee of this row's role, in parts per million of notional. |
| `fee_usdc` | numeric | The fee of this row's role, in USDC. |
| `position_before` | numeric | The account's position before the trade, in base units. Negative is short. |
| `position_after` | numeric | `position_before` plus `signed_size`. |
| `entry_quote_before_usdc` | numeric | The entry value of the account's position before the trade, in USDC. |
| `position_sign_changed` | boolean | True when the trade changed the sign of the account's position. |
| `realized_pnl` | numeric | The pnl the trade realized for this account, in USDC. Null when none. |

### Lighter batches

`analytics.lighter_batches`

One Lighter L1 batch: the L2 block range it holds, its tx count, its status, and the hash and time of its commit, verify and execute on Ethereum. One row per batch. Join an L2 block to its batch on `block_number between first_block and last_block`. Covers every batch from the one that holds `START_TIME` (2026-11-16 to start) to the newest. The Explorer's history starts on 2025-08-25, and about 830 batches close a day.

The `lighter` pipeline builds it from the call source `lighter-batches`, which reads Lighter's Explorer one batch at a time and keeps each reply whole. Each run reads again from the first batch not yet final, so a batch's L1 hashes fill in as it settles, which can take hours. A batch is final once it is `executed` or `nothing_to_execute`. `START_TIME` may not come before 2025-08-28: batches before 29654 carry no L1 status and never settle. `lighter_batches_are_contiguous` fails when a batch's block count differs from its range, or when two loaded neighbours do not meet. It runs daily at 07:30 UTC.

| Column | Type | Description |
|---|---|---|
| `batch_number` | bigint | The batch's number. Unique. |
| `first_block`, `last_block` | bigint | The lowest and highest L2 block the batch holds. |
| `block_count` | bigint | How many blocks the batch holds, `last_block - first_block + 1`. |
| `tx_count` | bigint | The txs in its blocks. |
| `first_block_time`, `last_block_time` | timestamptz | The first and last block's time, to the microsecond. |
| `status` | text | `pending`, `committed`, `verified`, `executed` or `nothing_to_execute`: the latest status change's, or `pending` with none. |
| `is_final` | boolean | True once the batch is `executed` or `nothing_to_execute`, a verified batch with no L1 work left. |
| `commit_tx_hash`, `committed_at` | text, timestamptz | The Ethereum tx that committed the batch, and when. Null until then. |
| `verify_tx_hash`, `verified_at` | text, timestamptz | The Ethereum tx that verified it, and when. A `nothing_to_execute` batch has these too. |
| `execute_tx_hash`, `executed_at` | text, timestamptz | The Ethereum tx that executed it, and when. Null on a `nothing_to_execute` batch. One tx can execute several batches. |
| `final_at` | timestamptz | When the batch became final. |
| `updated_at` | timestamptz | When the Explorer last updated the batch. |

### Lighter account movements

`analytics.lighter_account_movements`

One leg of a money move in a listed Lighter account's log: a deposit, a withdrawal, a transfer or its fee, a move between the account's perps and spot routes, a pool mint or burn, a stake, unstake or unlock, or a margin move. One row per entry, account and leg, with the L1 batch whose block range holds the entry's block and that batch's Ethereum hashes and times. Covers the accounts in `ingestion/sources/lighter-account-logs/addresses.json` (313004 and 693073 to start) and the sub-accounts of each L1 address listed there, from `START_TIME` (2026-11-16 to start). A transfer between two listed accounts gives the sender's legs under the sender and the receiver's under the receiver.

The `lighter` pipeline builds it from the call source `lighter-account-logs`, which walks each account's log on Lighter's Explorer, newest first, back to a day before the newest entry the last run saw. It skips plain trades, which [`lighter_trades`](#lighter-trades) holds, and reads `logs/{hash}` for each money move to find its L2 block. A money move has settled on Ethereum once its batch is `executed`, or `nothing_to_execute`: verified, with no L1 work left. `is_final` says so. The withdrawals checked so far sat in `executed` batches; deposits and transfers sat in either. A transfer to the fast-withdraw pool, likely account 675395, is the user's side of a fast withdrawal, so it shows as `transfer_out`, not `withdrawal`. `lighter_movements_match_detail_batch` warns when a row's batch differs from the one the Explorer names, or when a loaded batch should hold a row's block but none does. It runs daily at 07:30 UTC.

| Column | Type | Description |
|---|---|---|
| `id` | text | `<hash>:<account_index>:<leg>`. Unique. |
| `hash` | text | The entry's hash, the same in each account's log that holds it. |
| `log_time` | timestamptz | The entry's time, to the microsecond. Never join it to a batch by time. |
| `account_index` | bigint | The account whose log holds the entry, and whose leg this row is. |
| `leg` | text | `from`, `to` or `fee` for a transfer or route move, `self` for the rest. |
| `kind` | text | `deposit`, `withdrawal`, `transfer_out`, `transfer_in`, `transfer_fee`, `route_move`, `pool_mint`, `pool_burn`, `stake`, `unstake`, `unlock` or `margin_move`. |
| `asset` | text | The asset's symbol, such as `USDC` or `LIT`. |
| `route` | text | `perps` or `spot`. Null for stake, unstake, unlock and margin moves. |
| `amount` | numeric | The amount as Lighter sent it, in the asset's units. Unsigned. |
| `signed_amount` | numeric | `amount`, negative when it leaves the account or route. Null for stake, unstake, unlock and margin moves, whose sign is unproven. |
| `counterparty_account_index` | bigint | The other account of a transfer, the fee account of a fee, or the pool of a mint, burn, stake or unstake. |
| `l1_address` | text | The Ethereum address a deposit came from, lowercased. |
| `pubdata_type`, `tx_type` | text | The entry's type, such as `L2TransferV2`, and its tx's, such as `L2Transfer`. |
| `block_number` | bigint | The L2 block that holds the entry. Null until `logs/{hash}` answers. |
| `batch_number` | bigint | The loaded batch whose block range holds `block_number`. Null until that batch loads. |
| `detail_batch_number` | bigint | The batch `logs/{hash}` named, null when read before the batch formed. Use `batch_number`. |
| `batch_status`, `is_final` | text, boolean | The batch's status, and whether it is final, as in [`lighter_batches`](#lighter-batches). `is_final` is false with no batch. |
| `commit_tx_hash`, `committed_at` | text, timestamptz | The Ethereum tx that committed the batch, and when. |
| `verify_tx_hash`, `verified_at` | text, timestamptz | The Ethereum tx that verified the batch, and when. |
| `execute_tx_hash`, `executed_at` | text, timestamptz | The Ethereum tx that executed the batch, and when. Null on a `nothing_to_execute` batch. |
| `final_at` | timestamptz | When the batch became final. |

### Lighter account snapshots

`analytics.lighter_account_snapshots`, `analytics.lighter_account_position_snapshots` and `analytics.lighter_account_asset_snapshots`

Lighter's own reading of each listed account: its collateral and value, each position and each asset balance, one reading per run. Covers the accounts in `ingestion/sources/lighter-accounts/addresses.json` (313004 and 693073 to start) and the sub-accounts of each L1 address listed there. Readings start with the first run, since Lighter keeps no history of them.

The `lighter` pipeline builds them from the call source `lighter-accounts`, which reads each account once a run and keeps the reply whole. It runs daily at 07:30 UTC. A reading is a check for a ledger rebuilt from the logs, not a history.

`lighter_account_snapshots` has one row per account and reading:

| Column | Type | Description |
|---|---|---|
| `id` | text | `<account_index>:<read_at in ms>`. Unique. |
| `account_index` | bigint | The account. |
| `read_at` | timestamptz | When the run read it. |
| `l1_address` | text | The Ethereum address of the account, lowercased. |
| `account_type`, `status` | integer | As Lighter sends them. |
| `collateral` | numeric | USDC collateral. It leaves out unrealized pnl. |
| `available_balance` | numeric | USDC free to use. |
| `total_asset_value` | numeric | Collateral plus unrealized pnl. |
| `cross_asset_value`, `cross_initial_margin_requirement`, `cross_maintenance_margin_requirement` | numeric | The cross-margin value and its margin requirements. |
| `transaction_time` | timestamptz | Lighter's time for the reading, to the microsecond. |

`lighter_account_position_snapshots` has one row per account, market and reading. A closed position stays listed with `position` 0.

| Column | Type | Description |
|---|---|---|
| `id` | text | `<account_index>:<market_id>:<read_at in ms>`. Unique. |
| `account_index`, `read_at`, `market_id`, `symbol` | | As above. Join the market on `market_id`. |
| `position` | numeric | The size in base units, negative when short. Lighter sends it unsigned with a `sign`. |
| `avg_entry_price`, `position_value`, `unrealized_pnl`, `realized_pnl`, `liquidation_price` | numeric | As Lighter sends them. |
| `total_funding_paid_out` | numeric | Lighter leaves it out on some positions, so it can be null. |
| `margin_mode`, `allocated_margin`, `initial_margin_fraction` | | As Lighter sends them. |

`lighter_account_asset_snapshots` has one row per account, asset and reading:

| Column | Type | Description |
|---|---|---|
| `id` | text | `<account_index>:<asset_id>:<read_at in ms>`. Unique. |
| `account_index`, `read_at`, `asset_id`, `symbol` | | As above. |
| `balance`, `locked_balance`, `margin_balance` | numeric | In the asset's own units. |
| `margin_mode` | text | As Lighter sends it. |

### Lighter account value history

`analytics.lighter_account_value_history`

Lighter's own daily and hourly record of each listed account's value, from its `pnl` endpoint. It covers the accounts in `ingestion/sources/lighter-pnl/addresses.json` (313004 and 693073 to start) and the sub-accounts of each L1 address listed there. Unlike a snapshot, it goes back to the day the account began.

The `lighter` pipeline builds it from the call source `lighter-pnl`. Each run reads every account's `1d` series from `START_TIME` and its last 7 days of `1h`, and keeps each point whole. Lighter ends a series with a point at the request time. That point is still open, so the source leaves it for the next run. Lighter sends the values as JSON numbers, so they keep up to 15 significant digits.

One row per account, resolution and point time. Every column but `volume` is a running total since the account began, up to `point_time`, in USDC.

| Column | Type | Description |
|---|---|---|
| `id` | text | `<account_index>:<resolution>:<point time in s>`. Unique. |
| `account_index` | bigint | The account. |
| `resolution` | text | `1d` for a point at UTC midnight, `1h` for a point on the hour. |
| `point_time` | timestamptz | The time the totals run up to. |
| `perps_value` | numeric | `inflow - outflow + trade_pnl`: the account's collateral plus unrealized pnl at `point_time`. |
| `trade_pnl`, `trade_spot_pnl` | numeric | Perps and spot trading pnl. |
| `inflow`, `outflow` | numeric | USDC moved onto and off the perps route, each fee included. |
| `spot_inflow`, `spot_outflow` | numeric | The same on the spot route. |
| `pool_pnl`, `pool_inflow`, `pool_outflow` | numeric | Public pool pnl, and USDC into and out of pools. |
| `staking_pnl`, `staking_inflow`, `staking_outflow` | numeric | The same for staking. |
| `pool_total_shares` | numeric | Pool shares held. |
| `volume` | numeric | Trading volume in the period. |

The warn test `lighter_account_flows_match_pnl` checks the account log against these points. For each UTC day inside the window the log source loaded, it sets the day's change in `inflow`, `outflow`, `spot_inflow` and `spot_outflow` against the USDC movements in `lighter_account_movements` that day, and lists each account, day and field that differs.

TypeScript sources load raw rows into `raw.*`, dbt builds the models, and Dagster runs each pipeline as one job. Docker runs the warehouse, eRPC, Dshackle and monitoring. You drive it with the `bj` CLI (`dev`, `doctor`, `run`, `answer`, `report`, `new-source`) and the [blockjuice skill](#claude-code-skill). The contracts, events and ABIs of each protocol, and the endpoints and limits of each vendor API, are written up under `catalog/`.

The code is ordinary software engineering: typed sources, tests, schedules and docs a teammate can follow. [docs/architecture.md](docs/architecture.md) has the details.

### Accounts

`analytics.wallet_transactions`, `analytics.wallet_eth_outflows`, `analytics.account_states` and `analytics.address_attributions`

The wallets you follow on Ethereum. `wallet_transactions` holds each top-level transaction sent from or to them, in wei; internal transfers, which only traces show, are not here. `wallet_eth_outflows` takes each successful one with value and gives it one class: `sold` (a CoW Protocol ETH Flow order that settled into a stablecoin back to the sender), `sent_to_exchange` (to an address in `seeds/cex_addresses`) or `sent_out`. `account_states` holds each address's balance, nonce and code at the blocks a source read it. `address_attributions` lists the addresses a public body ties to an incident, from `seeds/attributed_addresses`.

The `accounts` pipeline builds them from the sources `evm-wallet-transactions` and `evm-account-state` and those seeds. `wallet_eth_outflows` also reads [`cow_ethflow_orders`](#cow-eth-flow).

| Column | Type | Description |
|---|---|---|
| `chain` | text | `ethereum`. |
| `tx_hash` | text | The transaction. |
| `from_address` | text | The sender. |
| `to_address` | text | The receiver. |
| `value_wei` | numeric | The ETH sent, in wei. It moved only when `succeeded` is true. |
| `succeeded` | boolean | Whether the transaction succeeded. |
| `fee_wei` | numeric | `gas_used × effective_gas_price`, paid by `from_address` either way. |
| `outflow_class` | text | `sold`, `sent_to_exchange` or `sent_out` (`wallet_eth_outflows`). |
| `code_kind` | text | `none`, `eip7702_delegation` or `contract` (`account_states`). |
| `attribution` | text | The incident a public body ties the address to (`address_attributions`). |

### Deployments

`analytics.deployment_state_gas`

One contract-deployment transaction per row on Ethereum: a successful transaction with at least one create or create2 that stood. `state_gas` is the EIP-8037 state gas its creates and new storage slots would cost, as a lower bound, and `rule_version` names the rule. The `deployments` pipeline builds it from the source `evm-contract-deployments`.

| Column | Type | Description |
|---|---|---|
| `chain` | text | `ethereum`. |
| `tx_hash` | text | The deployment transaction. Unique while the table holds one chain. |
| `block_number` | bigint | The block it was in. |
| `code_bytes` | bigint | The bytes of code its creates left. |
| `new_slots` | bigint | The new storage slots it wrote. |
| `state_gas` | bigint | The EIP-8037 state gas, in gas, as a lower bound. |
| `rule_version` | text | The rule `state_gas` follows. |

### CoW ETH Flow

`analytics.cow_ethflow_orders`

One CoW Protocol ETH Flow order placed by a wallet you follow on Ethereum, with the settlement that filled it when one did. Amounts are in token base units; the ETH sent is in wei. An order is settled when a later GPv2Settlement Trade carries its UID. An order with no such Trade may be open, expired, refunded or invalidated; this table does not tell them apart. The `cow` pipeline builds it from the source `evm-cow-ethflow`.

| Column | Type | Description |
|---|---|---|
| `order_uid` | text | The 56-byte GPv2 order UID. |
| `tx_hash` | text | The transaction that placed the order. |
| `owner` | text | The wallet that placed it. |
| `eth_value_wei` | numeric | The ETH sent, in wei. |
| `buy_token` | text | The token the order buys. |
| `settled` | boolean | True when a later GPv2Settlement Trade carries its UID. |
| `received_amount` | numeric | The buy token sent to the receiver, in base units. Null when not settled; 0 when nothing came or the receiver is not a wallet you follow. |

## How you use it

1. Set up once with `bj install`, start the stack and Dagster with `bj dev`, then open the Dagster UI.
2. Point sources at the wallets and tokens you care about, in each source's `addresses.json`. A source that covers several chains keeps one per chain under `chains/<chain>/`.
3. Materialize a pipeline (balances, transfers, dex or labels), then enable its schedule under **Automation → Schedules** if you want recurring runs.
4. Ask the business question in Claude Code. You get an answer folder with its checks, and a report if you want one.
5. When the brief changes, add a source, a chain or [your own pipeline](#add-your-own-pipeline). The [skill](#claude-code-skill) can walk you through any of these.

A new analyst should be able to get through these steps in an afternoon.

## Claude Code skill

BlockJuice includes a Claude Code skill at `.claude/skills/blockjuice/`. Start it with `/bj`. It lets an analyst run the stack without first learning every folder. It can:

- answer a question: scope it, find or build the marts, write a dbt analysis, run checks and write `answers/<slug>/` (`question.yaml`, `answer.json`, `answer.md`, `results/`)
- turn an answer into XLSX, PDF, Word or a Google Doc with `bj report`, using rows from your warehouse
- add a state or history source (a call source or a stream source) when the data isn't loaded yet
- add a pipeline when you need a reusable mart that no schedule builds yet
- explore a protocol, writing `catalog/protocols/<name>/` from real logs before anyone writes SQL against it

The skill runs every mechanical step through the `bj` CLI, so a person and an agent get the same checks. Answers and reports end up as files and warehouse tables you own. To see how the skill works, start at `.claude/skills/blockjuice/SKILL.md`.

## Add your own pipeline

A **pipeline** is a mart folder plus everything it reads (sources and models), run as one Dagster job on its own cron.

The easiest way to build one is to ask the [Claude Code skill](#claude-code-skill). Its new-pipeline workflow (`.claude/skills/blockjuice/workflows/new-pipeline.md`) has every step and runs them for you. To do it by hand:

1. Add mart models under `transformation/models/marts/<pipeline>/`, and any models only that pipeline needs under `transformation/models/intermediate/<pipeline>/`. Staging stays per source under `staging/<source>/`.
2. Register the name and schedule in `PIPELINES` in `orchestration/pipeline/schedules.py`.
3. If you need new raw data first, add a source (`bj new-source …`, see [Add a source](docs/architecture.md#add-a-source)), then point the mart at its staging models.
4. Materialize once in Dagster (or `bj run <pipeline>`) and confirm the tests pass.
5. Open **Automation → Schedules** in Dagster, enable the pipeline's schedule and check its next tick. Keep Dagster running for the scheduled runs.

Orchestration tests fail if an asset belongs to no scheduled pipeline, so nothing ships that never runs. [Add a pipeline](docs/architecture.md#add-a-pipeline) has the full steps.

## Docs

| Doc | Read it for |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layout, data flow, CLI reference, monitoring, adding sources and pipelines |
| [GLOSSARY.md](GLOSSARY.md) | Terms: source, stream source, call, record, batch, run, dead letter |
| [transformation/README.md](transformation/README.md) | dbt models, and adding a chain to balances |
| `.claude/skills/blockjuice/` | The skill's workflows, from question to report |

## Status

BlockJuice is in active development. For now the framework is this repository: clone it, run `bj install` and `bj dev`, and you have your own warehouse. No value in `.env` is required: the defaults read public RPCs and the keyless SQD Portal. Set `PORTAL_API_KEY` to raise Portal's limits. We're working on thinner packaging for customer apps. The parts analysts touch (`name`/`table`, mart shapes, `bj`) should stay the same when it ships.

## License

BlockJuice is licensed under the [Apache License 2.0](LICENSE). Dependencies and externally sourced data retain their respective licenses and terms.
