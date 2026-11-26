# Answers

## Overview

Each answer folder `answers/<slug>/` holds a `question.yaml` and an `analyses/` folder of dbt analyses: one question's filter and aggregation over marts. It may also hold a `macros/` folder. dbt compiles analyses but never builds them. `bj answer <slug>` points dbt at that answer's folders, compiles the analyses its `question.yaml` names with the question's window, runs them and writes their results. Every analysis sits in one answer's folder, so this README groups them by question. `docs/analysis-authoring.md` covers writing one.

## Interface

In each group the first analysis is the headline: when it returns one row of one column, that cell is the answer's value (`orchestration/pipeline/analysis/domain.py`). The others break it down. An answer with a `reference` key in its `question.yaml` ships `reference.csv`, the rows that the analysis named there must return over the `eval_window`. `bj answer --eval` compares them.

The analyses below are in each answer's `analyses/` folder.

### Ethereum flows and deployments

- `binance-hack-fbi-eth-2026-11-01`: ETH that the Ethereum addresses the FBI attributes to the Binance hack sent out since 29 October 2026, and what they hold.
  - Analyses: `headline`, `totals`, `by_address`, `with_code`.
  - Reads `address_attributions`, `wallet_transactions` and `account_states` through `attributed_eth_flows()`, with `window_start('ethereum')` and `window_end('ethereum')`.
  - Macro `attributed_eth_flows(attribution, chain, from_block, to_block, code_also_at)` in `macros/attributed_eth_flows.sql`: one row per address in `ref('address_attributions')` with that `attribution` on `chain`, with top-level native flows from `ref('wallet_transactions')` over the blocks, and the state from `ref('account_states')` at `state_block`, the latest block at or before `to_block` that has reads. Columns: `address`, `state_block`, `sent_txs`, `sent_failed_txs`, `sent_value_wei`, `sent_fees_wei`, `sent_out_wei`, `blob_fees_wei`, `received_txs`, `received_wei`, `balance_wei`, `nonce`, `code_kind`, `has_code`, `active`. `sent_value_wei` and `received_wei` count successful transactions only; `sent_fees_wei` counts every transaction the address sent, reverted ones too. Blob fees stay out of `sent_out_wei`, and internal transfers are in neither. `has_code` is null when a code read at `code_also_at` or `state_block` has not loaded and none found code.
  - Reference: `reference.csv`, checked against `by_address_metric`.
- `ef-linked-wallet-eth-outflows-2026-11-10`: how much ETH the wallet Lookonchain links to the Ethereum Foundation sent out, when, and where.
  - Analyses: `headline`, `by_outflow`, `by_class`, `by_day`, `reconciliation`.
  - Reads `wallet_eth_outflows`; `reconciliation` reads `wallet_transactions`. Window through `in_window()`.
  - Reference: `reference.csv`, checked against `by_outflow`.
- `mexc-labelled-flows-2026-11`: whether daily ETH, USDT and USDC flows of the wallets labelled MEXC changed after FinCEN's 6 November 2026 order.
  - Analyses: `headline`, `by_period`, `by_day`.
  - Reads `labelled_wallet_flows` and `tokens` through `labelled_flows_daily()`, with `window_start` and `window_end`.
  - Macro `labelled_flows_daily(entity, chain, assets, counterparties, from_block, to_block)` in `macros/labelled_flows.sql`: daily flows of `entity`'s labelled wallets from `ref('labelled_wallet_flows')`, in long form: `day`, `token`, `counterparty`, `metric`, `amount`. `assets` is a list of `[token, asset]` pairs, where `asset` is `'native'` or a token address. Metrics: `inflow`, `outflow`, `net`, `inflow_transfers`, `outflow_transfers`, and for counterparty `all` also `intra` and `intra_transfers`. Amounts are whole tokens, multiplied by `10^-decimals` rather than divided, since numeric division rounds to about 16 significant digits. Native assets use 18 decimals; a token missing from `ref('tokens')` gets null amounts. `net` is `inflow - outflow` and leaves out `intra` moves between the entity's own wallets. Only days with at least one flow appear.
  - Reference: `reference.csv`, checked against `by_day`.
- `eip8037-state-gas-deployments-2026-11-08`: how many contract-deployment transactions since 12 August 2026 would have an EIP-8037 state-gas cost above 60M, 150M and 200M gas.
  - Analyses: `headline`, `by_threshold`, `distribution`, `wildcat`.
  - Reads `deployment_state_gas`. Window through `in_window()`.
  - Reference: `reference.csv`, checked against `by_threshold`.

### Balances

- `tracked-wallets-eth`: how much ETH the tracked wallets hold now.
  - Analyses: `headline`, `by_wallet`.
  - Reads `latest_balances` (`chain = 'ethereum'`, `asset_type = 'native'`). The window is `at: latest`, so no window macro.
- `tracked-wallets-sol`: how much SOL the tracked Solana wallets hold now.
  - Analyses: `headline`, `by_wallet`.
  - Reads `latest_balances` (`chain = 'solana'`, `asset_type = 'native'`). The window is `at: latest`, so no window macro.

### DEX

- `uni-v3-uni-swaps-2026-10-15`: how many Uniswap v3 swaps traded UNI on Ethereum on 2026-10-15, and their UNI volume.
  - Analyses: `headline`, `volume`, `by_pool`.
  - Reads `dex_trades`; `volume` and `by_pool` also read `tokens` for UNI's decimals. Window through `in_window()`.
  - Reference: `reference.csv`, checked against `by_pool`.

### Polymarket

- `polymarket-overview`: what the loaded Polymarket maker trades and market positions show.
  - Analyses: `headline`, `by_day`, `by_event`, `by_fill_size`, `by_hour`, `by_market`, `by_market_type`, `by_pnl_bucket`, `by_price`, `by_wallet`, `kpis`, `top_market_prices`.
  - Reads `polymarket_trades`, `polymarket_markets`, `polymarket_price_candles` and `polymarket_market_participants`. The window is `scope: loaded`, so no window macro: each analysis covers every loaded row.
- `rn1-polymarket-fills-2026-11-08`: what share of RN1's fills were maker-side in Polygon blocks 96972629 to 96975028, and how they break down.
  - Analyses: `headline`, `by_market`, `by_phase`, `by_role`, `by_token`, `pairs`.
  - Reads `polymarket_wallet_fills`; all but the headline also read `polymarket_markets`. Window through `in_window(..., 'polygon')`.
  - Reference: `reference.csv`, checked against `by_token`.

### The configured token

These four questions follow the token in `var('token')`: its Ethereum address, its decimals and one `{chain, token, blocks}` window per chain. `dbt_project.yml` sets the default, and each `question.yaml` declares it under `parameters.token`. They read transfers through `token_transfers()`, bridge moves through `token_bridge_transfers()` and scale amounts with `token_unit()`.

- `token-categories`: how the token's transfers divide among exchange, bridge, contract and peer-to-peer flows.
  - Analyses: `headline`, `bridges`, `by_category`, `contracts`, `exchanges`, `p2p`.
  - Reads `classified_transfers`. `bridges` reads `bridge_transfers`, `bridge_pairs` and `address_labels` instead, and `p2p` reads all four.
- `token-flow-map`: how the token moves between address groups and exchanges.
  - Analyses: `headline`, `cross_exchange`, `edges`, `groups`.
  - Reads `classified_transfers`; `edges` also reads `bridge_transfers`, `bridge_pairs` and `address_labels`.
- `token-net-accumulators`: which addresses gained the most of the token.
  - Analyses: `headline`, `by_wallet`.
  - Reads `erc20_transfers`, the default of `token_transfers()`.
- `token-transfer-graph`: which wallets and directed wallet pairs make up the token's transfer graph.
  - Analyses: `headline`, `by_edge`, `by_wallet`.
  - Reads `erc20_transfers`, the default of `token_transfers()`.

## Invariants

- Each analysis sits in `answers/<slug>/analyses/` and is named by that answer's `question.yaml`. `bj questions --check` (`orchestration/pipeline/cli/catalog.py:run`) reads every `answers/*/question.yaml` on disk, tracked or not, and fails on an analysis its `question.yaml` does not name and on any `.sql` file under `transformation/analyses/`, a folder that no longer exists. Commit a `question.yaml` in the same PR as the analyses it names.
- dbt reads one answer at a time. `bj answer` sets `BJ_ANALYSES` and `BJ_MACROS` to the answer's `analyses/` and `macros/` folders, as paths from `transformation/`, around its dbt compile and dbt test (`orchestration/pipeline/cli/answer.py:question_paths`), and restores them after. `dbt_project.yml` falls back to the missing folders `analyses` and `question-macros`, so a plain dbt command sees no analysis.
- Analysis names are unique inside one answer's `analyses/` folder and its subfolders; `orchestration/pipeline/cli/catalog.py:analysis_paths` raises on a duplicate. Two answers may use the same name.
- An analysis reads marts through `ref()`. Every `ref()` here names a model in `transformation/models/marts/`.
- An analysis takes its blocks from `transformation/macros/window.sql`, or, for the token analyses, from `var('token').windows` through `token_transfers()` and `token_bridge_transfers()`. `orchestration/tests/test_analysis_rules.py::test_no_analysis_writes_its_window_blocks` fails when a bound of a question's `window` or `eval_window` appears in one of its analyses. The only exception, in `FIXED_BLOCKS`, is block 26294680 for `binance-hack-fbi-eth-2026-11-01`, where that question reads code.
- Outside `bj answer` an analysis that calls a window macro compiles but fails when run, with `no window for <chain>`. The analyses of `polymarket-overview`, the `token-*` answers and `tracked-wallets-*` call none, so they run outside it too, the token ones with `dbt_project.yml`'s default `token`. To run a windowed one by hand, set `BJ_ANALYSES=../answers/<slug>/analyses` and pass `--vars '{window: {ethereum: [<first block>, <last block>]}, inputs: {<input>: {<key>: [<value>]}}}'`, the `inputs` part only for an analysis that calls `input_values`.
- The token analyses name no token address; the token comes from `var('token')`. Keep it that way, so the pipelines stay token-agnostic.
- A question with a `reference` key has `answers/<slug>/reference.csv` and an `eval_window`. `orchestration/tests/test_analysis_rules.py::test_every_reference_has_its_rows_and_an_eval_window` fails when either is missing.

## Side Effects

- None from the files themselves: `bj answer` compiles analyses into a temporary folder and dbt never creates a relation for them.
- `bj answer <slug>` runs the compiled SQL read-only against the warehouse and writes `answers/<slug>/answer.json` and `answers/<slug>/results/<analysis>.csv`, or `eval/` with `--eval`. Git ignores those outputs (`.gitignore`), but still tracks `answer.json`, `answer.md` and `results/*.csv` of `tracked-wallets-eth` and `tracked-wallets-sol`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- Run: `uv run --project orchestration bj questions --check`
- Compile the answer you changed as CI does: from `transformation/`, with `.env` exported, `BJ_ANALYSES=../answers/<slug>/analyses BJ_MACROS=../answers/<slug>/macros uv run --project ../orchestration dbt compile --select <its analyses>`. A plain `dbt parse` reads no analysis.
- Run: `uv run --project orchestration pytest orchestration/tests/test_analysis_rules.py orchestration/tests/test_analysis_empty_windows.py`
- With a warehouse up: `uv run --project orchestration bj answer <slug>`.
