# Answers

## Overview

Each answer folder `answers/<slug>/` holds a `question.yaml` and an `analyses/` folder of dbt analyses: one question's filter and aggregation over marts. It may also hold a `macros/` folder. dbt compiles analyses but never builds them. `bj answer <slug>` points dbt at that answer's folders, compiles the analyses its `question.yaml` names with the question's window, runs them and writes their results. Every analysis sits in one answer's folder, so this README groups them by question. `docs/analysis-authoring.md` covers writing one.

## Interface

In each group the first analysis is the headline: when it returns one row of one column, that cell is the answer's value (`orchestration/pipeline/analysis/domain.py`). The others break it down. A reference test in `transformation/tests/reference/<slug with _>_matches_reference.sql` checks some of them against the factory's reference rows.

The analyses below are in each answer's `analyses/` folder.

### Ethereum flows and deployments

- `binance-hack-fbi-eth-2026-11-01`: ETH that the Ethereum addresses the FBI attributes to the Binance hack sent out since 29 October 2026, and what they hold.
  - Analyses: `binance_hack_fbi_eth_2026_11_01`, `_totals`, `_by_address`, `_with_code`.
  - Reads `address_attributions`, `wallet_transactions` and `account_states` through `attributed_eth_flows()`, with `window_start('ethereum')` and `window_end('ethereum')`.
  - Reference test: `binance_hack_fbi_eth_2026_11_01_matches_reference.sql`.
- `ef-linked-wallet-eth-outflows-2026-11-10`: how much ETH the wallet Lookonchain links to the Ethereum Foundation sent out, when, and where.
  - Analyses: `ef_linked_wallet_eth_outflows_2026_11_10`, `_by_outflow`, `_by_class`, `_by_day`, `_reconciliation`.
  - Reads `wallet_eth_outflows`; `_reconciliation` reads `wallet_transactions`. Window through `in_window()`.
  - Reference test: `ef_linked_wallet_eth_outflows_2026_11_10_matches_reference.sql`.
- `mexc-labelled-flows-2026-11`: whether daily ETH, USDT and USDC flows of the wallets labelled MEXC changed after FinCEN's 6 November 2026 order.
  - Analyses: `mexc_labelled_flows_2026_11`, `_by_period`, `_by_day`.
  - Reads `labelled_wallet_flows` and `tokens` through `labelled_flows_daily()`, with `window_start` and `window_end`.
  - Reference test: `mexc_labelled_flows_2026_11_matches_reference.sql`.
- `eip8037-state-gas-deployments-2026-11-08`: how many contract-deployment transactions since 12 August 2026 would have an EIP-8037 state-gas cost above 60M, 150M and 200M gas.
  - Analyses: `eip8037_state_gas_deployments_2026_11_08`, `_by_threshold`, `_distribution`, `_wildcat`.
  - Reads `deployment_state_gas`. Window through `in_window()`.
  - Reference test: `eip8037_state_gas_deployments_2026_11_08_matches_reference.sql`.

### Balances

- `tracked-wallets-eth`: how much ETH the tracked wallets hold now.
  - Analyses: `tracked_wallets_eth`, `tracked_wallets_eth_by_wallet`.
  - Reads `latest_balances` (`chain = 'ethereum'`, `asset_type = 'native'`). The window is `at: latest`, so no window macro.
- `tracked-wallets-sol`: how much SOL the tracked Solana wallets hold now.
  - Analyses: `tracked_wallets_sol`, `tracked_wallets_sol_by_wallet`.
  - Reads `latest_balances` (`chain = 'solana'`, `asset_type = 'native'`). The window is `at: latest`, so no window macro.

### DEX

- `uni-v3-uni-swaps-2026-10-15`: how many Uniswap v3 swaps traded UNI on Ethereum on 2026-10-15, and their UNI volume.
  - Analyses: `uni_v3_uni_swaps_2026_10_15`, `_volume`, `_by_pool`.
  - Reads `dex_trades`; `_volume` and `_by_pool` also read `tokens` for UNI's decimals. Window through `in_window()`.
  - Reference test: `uni_v3_uni_swaps_2026_10_15_matches_reference.sql`.

### Polymarket

- `polymarket-overview`: what the loaded Polymarket maker trades and market positions show.
  - Analyses: `polymarket_overview`, `_by_day`, `_by_event`, `_by_fill_size`, `_by_hour`, `_by_market`, `_by_market_type`, `_by_pnl_bucket`, `_by_price`, `_by_wallet`, `_kpis`, `_top_market_prices`.
  - Reads `polymarket_trades`, `polymarket_markets`, `polymarket_price_candles` and `polymarket_market_participants`. The window is `scope: loaded`, so no window macro: each analysis covers every loaded row.
- `rn1-polymarket-fills-2026-11-08`: what share of RN1's fills were maker-side in Polygon blocks 96972629 to 96975028, and how they break down.
  - Analyses: `rn1_polymarket_fills_2026_11_08`, `_by_market`, `_by_phase`, `_by_role`, `_by_token`, `_pairs`.
  - Reads `polymarket_wallet_fills`; all but the headline also read `polymarket_markets`. Window through `in_window(..., 'polygon')`.
  - Reference test: `rn1_polymarket_fills_2026_11_08_matches_reference.sql`.

### The configured token

These four questions follow the token in `var('token')`: its Ethereum address, its decimals and one `{chain, token, blocks}` window per chain. `dbt_project.yml` sets the default, and each `question.yaml` declares it under `parameters.token`. They read transfers through `token_transfers()`, bridge moves through `token_bridge_transfers()` and scale amounts with `token_unit()`.

- `token-categories`: how the token's transfers divide among exchange, bridge, contract and peer-to-peer flows.
  - Analyses: `token_categories`, `_bridges`, `_by_category`, `_contracts`, `_exchanges`, `_p2p`.
  - Reads `classified_transfers`. `_bridges` reads `bridge_transfers`, `bridge_pairs` and `address_labels` instead, and `_p2p` reads all four.
- `token-flow-map`: how the token moves between address groups and exchanges.
  - Analyses: `token_flow_map`, `_cross_exchange`, `_edges`, `_groups`.
  - Reads `classified_transfers`; `_edges` also reads `bridge_transfers`, `bridge_pairs` and `address_labels`.
- `token-net-accumulators`: which addresses gained the most of the token.
  - Analyses: `token_net_accumulators`, `token_net_accumulators_by_wallet`.
  - Reads `erc20_transfers`, the default of `token_transfers()`.
- `token-transfer-graph`: which wallets and directed wallet pairs make up the token's transfer graph.
  - Analyses: `token_transfer_graph`, `_by_edge`, `_by_wallet`.
  - Reads `erc20_transfers`, the default of `token_transfers()`.

## Invariants

- Each analysis sits in `answers/<slug>/analyses/` and is named by that answer's `question.yaml`. `bj questions --check` (`orchestration/pipeline/cli/catalog.py:run`) reads every `answers/*/question.yaml` on disk, tracked or not, and fails on an analysis its `question.yaml` does not name and on any `.sql` file under `transformation/analyses/`, a folder that no longer exists. Commit a `question.yaml` in the same PR as the analyses it names.
- dbt reads one answer at a time. `bj answer` sets `BJ_ANALYSES` and `BJ_MACROS` to the answer's `analyses/` and `macros/` folders, as paths from `transformation/`, around its dbt compile and dbt test (`orchestration/pipeline/cli/answer.py:question_paths`), and restores them after. `dbt_project.yml` falls back to the missing folders `analyses` and `question-macros`, so a plain dbt command sees no analysis.
- Analysis names are unique inside one answer's `analyses/` folder and its subfolders; `orchestration/pipeline/cli/catalog.py:analysis_paths` raises on a duplicate. Two answers may use the same name.
- An analysis reads marts through `ref()`. Every `ref()` here names a model in `models/marts/`.
- An analysis takes its blocks from `macros/window.sql`, or, for the token analyses, from `var('token').windows` through `token_transfers()` and `token_bridge_transfers()`. `orchestration/tests/test_analysis_rules.py::test_no_analysis_writes_its_window_blocks` fails when a bound of a question's `window` or `eval_window` appears in one of its analyses. The only exception, in `FIXED_BLOCKS`, is block 26294680 for `binance-hack-fbi-eth-2026-11-01`, where that question reads code.
- Outside `bj answer` an analysis that calls a window macro compiles but fails when run, with `no window for <chain>`. The `polymarket_overview*`, `token_*` and `tracked_wallets_*` analyses call none, so they run outside it too, the token ones with `dbt_project.yml`'s default `token`. To run a windowed one by hand, set `BJ_ANALYSES=../answers/<slug>/analyses` and pass `--vars '{window: {ethereum: [<first block>, <last block>]}}'`.
- The token analyses name no token address; the token comes from `var('token')`. Keep it that way, so the pipelines stay token-agnostic.
- A reference test in `transformation/tests/reference/` is named for its question's slug with `_` for `-`. `test_every_reference_test_has_its_question` fails when no `question.yaml` matches.

## Side Effects

- None from the files themselves: dbt compiles analyses into `transformation/target/` and never creates a relation for them.
- `bj answer <slug>` runs the compiled SQL read-only against the warehouse and writes `answers/<slug>/answer.json` and `answers/<slug>/results/<analysis>.csv`, or `eval/` with `--eval`. Git ignores those outputs (`.gitignore`), but still tracks `answer.json`, `answer.md` and `results/*.csv` of `tracked-wallets-eth` and `tracked-wallets-sol`.

## Verification

- Run: `set -a && . ./.env && set +a && uv run --project orchestration dbt parse --project-dir transformation --profiles-dir transformation`
- Run: `uv run --project orchestration bj questions --check`
- Run: `uv run --project orchestration pytest orchestration/tests/test_analysis_rules.py orchestration/tests/test_analysis_empty_windows.py`
- With a warehouse up: `uv run --project orchestration bj answer <slug>`.
