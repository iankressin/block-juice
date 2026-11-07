# Stablecoin briefs: implementation plans (docs only)

**For:** Ian  
**From:** BJ Pipeline Implementation Planner, through BJ Team Lead  
**Date:** 2026-11-07  
**Repo:** `main` at `def118f29d45011a8a501f953d06aa430bf54c79` (after the analyst snapshot `c8b72aef02c676348df290e29ca33c76545638e0`)  
**Mode:** Documentation only. No source, model, schedule, or warehouse change ships in this pull request.  
**Review:** BJ Quality Gate review of this pull request is pending. These plans are not merge-ready and are not publication approval.

This folder is a new batch. It does not edit `docs/plans/00-consolidated-pr-brief.md` through `docs/plans/05-orchestration.md`. Engineering A–H stays on hold.

| Document | Pipeline | Quality Gate status in these plans |
|---|---|---|
| [ousd-address-concentration.md](./ousd-address-concentration.md) | OUSD address concentration | Method accepted conditionally. First issuance per chain is unresolved. |
| [ethereum-usdc-supply.md](./ethereum-usdc-supply.md) | Ethereum USDC gross mints and burns versus net change in Ethereum USDC supply | Method accepted conditionally. Historical proxy semantics are an on-chain gate. The attached SQL is not a validation gate. |
| [usdt-transfer-share.md](./usdt-transfer-share.md) | USDT transfer-volume share inside a TRON / Ethereum / Solana panel | **Blocked as specified.** The stage rules below are a proposed repair, not an approved panel. |

Words match [GLOSSARY.md](../../../GLOSSARY.md). The person who reads the marts and the answer is an analyst.

## Objective

Turn three editorially approved briefs into repo-grounded plans an analyst can implement later, one pipeline at a time, after Ian closes the decisions listed below and after BJ Quality Gate reviews this pull request.

## Non-goals

- No ingestion package, dbt model, Dagster schedule, seed row, or catalog proof is added here.
- No pipeline run, backfill, warehouse query, or paid data call.
- No merge.
- No claim that a concentration, a supply change, or a TRON share has been measured. Nothing in this folder is an analytical finding.
- X posts and engagement counts in the discovery note are discovery context. They are not inputs to these plans.

## What the current tree changes relative to the analyst snapshot

`git diff --stat c8b72aef02c676348df290e29ca33c76545638e0 HEAD` is nine files: Binance and Coinbase vendor catalog entries, two one-line source comments, and small edits to `docs/architecture.md`, `CLAUDE.md`, and `.claude/skills/blockjuice/SKILL.md`. None of those files add a chain, a token filter, a cursor, or a mart used by these three questions. Every capability statement below was read on `def118f`.

## Repo facts that shape all three plans

These are facts about files. They are not chain findings.

| Fact | Where it was read |
|---|---|
| Sources, dbt, and Dagster are the three layers. A mart is one kind of fact for every chain it covers. A pipeline is one mart folder plus its upstream, one Dagster job, one cron line in `PIPELINES`. | `docs/architecture.md`, `GLOSSARY.md`, `orchestration/pipeline/schedules.py` |
| `ingestion/sources.json` lists the committed sources. There is no TRON source and no Tempo source. Solana entries are `solana.sol_balances` and `solana.spl_balances` only. | `ingestion/sources.json` |
| EVM history is a Pipes stream. `portalClient` sets `finalized: true`. Each run ends at `finalizedHead`. The cursor lives in `raw._sync`, committed with the batch. The next run resumes after that cursor. A run reads at most about 1,000,000 blocks. A stream source has no dead letters. | `ingestion/lib/src/portal.ts`, `ingestion/lib/src/warehouse/stream.ts`, `ingestion/lib/src/source.ts`, `ingestion/lib/src/run/index.ts` |
| `bj coverage` reports `START_BLOCK` through the cursor for the `addresses.json` it reads now. The history workflow states that coverage assumes the filter has not changed since `START_BLOCK`. Widening a filter and resuming does not load the omitted history. A reset deletes the `_sync` row and truncates the raw table. | `orchestration/pipeline/cli/coverage.py`, `.claude/skills/blockjuice/workflows/history-source.md` |
| Ethereum ERC-20 transfers are wallet-filtered. `chains/ethereum/addresses.json` lists three wallets and USDC, USDT, and DAI. It does not list OUSD. The package comment and test show that a transfer touching none of the wallets is dropped. The checked-in `START_BLOCK` comment says `26316189` is the first block of 2026-11-01 UTC. That comment was not re-checked against a block header in this pass. | `ingestion/sources/evm-erc20-transfers/chains/ethereum/addresses.json`, `ingestion/sources/evm-erc20-transfers/chains/ethereum/.env.example`, `ingestion/sources/evm-erc20-transfers/src/source.ts`, `ingestion/sources/evm-erc20-transfers/src/source.test.ts` |
| Base and Arbitrum transfer folders list a single UNI token and no `wallets` key, so those chains load every Transfer of that token. OUSD is not listed. Base `START_BLOCK` comment says `52011727` is the first block of 2026-10-01 UTC. That comment was not re-checked against a block header. | `ingestion/sources/evm-erc20-transfers/chains/base/addresses.json`, `chains/base/.env.example`, `chains/arbitrum/addresses.json` |
| `analytics.erc20_transfers` unions Ethereum, Arbitrum, and Base. `analytics.classified_transfers` labels a zero-address side as `bridge`. That rule is the transfers pipeline's category, and these plans do not reuse it as a mint or burn definition. | `transformation/models/marts/transfers/erc20_transfers.sql`, `classified_transfers.sql` |
| ERC-20 balances and metadata are call sources at one `BLOCK_NUMBER` for the addresses in `addresses.json`. Balance default is `finalized`. Metadata default is `latest`. `analytics.tokens` keeps the latest reading per chain and token. A null `decimals` stays null. | `ingestion/sources/evm-erc20-balances/.env.example`, `ingestion/sources/evm-erc20-metadata/.env.example`, `transformation/models/marts/tokens/tokens.sql` |
| Solana SPL balances read `getTokenAccountsByOwner` at the latest finalized slot for three wallets and three mints, one of which is the Tether Solana mint. The client comment says Solana RPCs serve current state and do not take a historical slot. Amounts are summed across token accounts for that current call. There is no instruction history, no owner history, and no OUSD mint in that file. | `ingestion/lib/src/solana/client.ts`, `ingestion/sources/solana-spl-balances/src/source.ts`, `src/balances.ts`, `addresses.json` |
| Solana addresses are case-sensitive and are not lowercased. EVM staging lowercases addresses. | `ingestion/lib/src/solana/address.ts`, `transformation/models/staging/ethereum/stg_ethereum__erc20_transfers.sql` |
| `bj blocks` knows eleven EVM Portal datasets, including `ethereum-mainnet` and `base-mainnet`. It has no Solana, TRON, or Tempo entry. | `orchestration/pipeline/cli/blocks.py` |
| eRPC aliases in this repo are ethereum, arbitrum, base, and solana. | `infra/erpc/erpc.yaml` |
| A Portal dataset list fetched on 2026-11-07 includes `ethereum-mainnet`, `base-mainnet`, `solana-mainnet`, and `tron-mainnet`. No dataset name in that list contains `tempo`. | `GET https://portal.sqd.dev/datasets` |
| Raw rows are `id`, `data` jsonb, `_loaded_at` timestamptz. Bigints are written as strings because jsonb numbers lose precision past 2^53. Staging casts transfer `value` to `numeric` and `timestamp` to `timestamptz`. | `ingestion/lib/src/warehouse/index.ts`, `stg_ethereum__erc20_transfers.sql` |
| Each source run gets a UUID `run_id`. Dagster passes `DAGSTER_RUN_ID`. Both land on `ops.ingestion_runs`. dbt builds land on `ops.dbt_invocations` and `ops.dbt_node_runs` only when Dagster runs them. `ops.pipeline_runs` joins those on the Dagster run id. The coverage CLI reads `current_number` from `_sync`. A warehouse test fixture treats `current_hash` as a required Pipes column. Neither the run log nor `bj coverage` stores the filter hash that produced the rows. | `ingestion/lib/src/run/index.ts`, `infra/postgres/ops.sql`, `orchestration/pipeline/assets/ingestion.py`, `orchestration/pipeline/warehouse.py`, `orchestration/tests/test_warehouse.py` |
| `seeds/cex_addresses` is Dune `cex.addresses` for UNI movers on Arbitrum and Base in October 2026, queried 2026-11-05. It is not a dated label ledger for OUSD or USDT. | `transformation/seeds/_seeds.yml` |
| Marts are tables. Staging and the existing pipeline intermediate folders are views. A new mart folder is unscheduled until its name is added to `PIPELINES`. A test fails when any asset sits outside a scheduled job. `pnpm generate-sources` rewrites `sources.json`, and a test fails when the file is stale. | `transformation/dbt_project.yml`, `orchestration/pipeline/schedules.py`, `orchestration/tests/test_definitions.py`, `.claude/skills/blockjuice/workflows/new-pipeline.md` |
| A protocol catalog entry is written before a source, and every deploy block and proof log in it comes from chain data. This pull request does not add catalog files, because those proofs are not collected yet. | `.claude/skills/blockjuice/workflows/explore-protocol.md` |
| Answers live in gitignored `answers/<slug>/`. `bj answer` checks coverage for a history input. `bj report` builds xlsx, pdf, docx, and a Google Doc. | `.gitignore`, `.claude/skills/blockjuice/references/question-spec.md`, `docs/architecture.md` |

## Shared design rules

1. **New raw tables.** These questions need every log of a named contract. The checked-in Ethereum transfer source keeps its three wallets, its token list, its `START_BLOCK`, and its cursor. New packages write `raw.<chain>_<table>` of their own. Implementation does not delete `raw._sync` for `ethereum_erc20_transfers`.
2. **One contract system per raw table.** OUSD, USDC, and USDT do not share a stream. A failure or a reset on one token does not move the others' cursors.
3. **History in, rules in dbt.** Sources write decoded logs and pinned state calls. Mint classification, holder balances, HHI, shares, and labels are intermediate and mart work. Staging casts types and does not apply a business rule.
4. **No wallet filter on the new history sources.** A `wallets` key is a failed run, not an empty filter.
5. **Finality is per chain and is stored.** Ethereum streams stop at Portal's finalized head, which is the mechanism already in `portal.ts`. Base uses the same Portal flag on `base-mainnet`; this repo does not define an extra L1 challenge-period cutoff, and the plans do not treat a sequencer head as the cutoff. Solana history, once built, stops at a finalized slot. TRON history, once built, stops at a solidified block. Tempo has no Portal dataset in the fetched list, so its finality rule is an open decision.
6. **Coverage is a manifest row, not a green job.** `opening + mints − burns = closing` is necessary and does not prove that omitted mints and omitted burns cancelled. A mart row is visible to an analyst only when the manifest for that chain and window has `coverage_status = 'pass'`. `unknown` and `fail` fail the dbt build. A day with no events is a zero only after that day's canonical range passed.
7. **Provenance exception.** Meeting that manifest needs the filter hash and the cursor hash recorded with the run. `bj coverage` reads today's `addresses.json`, so it cannot prove the filter that was loaded. The proposed writer is a small change to `ingestion/lib/src/run/index.ts`, which [layers.md](../../../.claude/skills/blockjuice/references/layers.md) tells a new source not to do. Ian approves or rejects that exception in the decisions below. Until it is approved, implementation of the three pipelines waits.
8. **Addresses are ledger units.** An EVM or TRON unit is an address. A Solana unit for concentration and for owner-self is the token-account authority owner at that instruction, summed across that owner's token accounts. Neither unit is a person, a wallet user, or adoption.
9. **Claim ceiling.** Each answer states the rule version, the chain, and the window. It does not state fiat inflows, liquidity, unique people, beneficial ownership, retail payments, economic settlement, wash trading, or a bound on a figure that came from somewhere else.

## Shared phased changes

These files serve more than one pipeline. Each has one owner. Pipeline files are listed in that pipeline's plan.

| Phase | Path | Change | Owner |
|---|---|---|---|
| 0 | `infra/postgres/ops.sql` | Add `ops.source_manifests`: `run_id`, `dagster_run_id`, source, table, `started_at`, `filter_sha256`, `start_block`, `cursor_number`, `cursor_hash`, `portal_url`, `finality` text, `chain_id`. Insert is idempotent on `run_id`. | BJ Orchestration |
| 0 | `ingestion/lib/src/run/index.ts` and `ingestion/lib/src/warehouse/index.ts` | After a successful stream run, write one manifest row from the filter bytes the run actually parsed and from the `_sync` row just committed. Failed runs write nothing. This is the layers.md exception above. | BJ Ingestion |
| 0 | `ingestion/lib/src/run/run.test.ts`, `ingestion/lib/src/warehouse/stream.test.ts` | A stream run records the filter hash. A second run does not invent a backfill behind the cursor. | BJ Ingestion |
| 0 | `transformation/models/staging/ops/` (new `_ops__sources.yml`, `stg_ops__source_manifests.sql`) | Cast the manifest. `timestamptz` stays `timestamptz`. | BJ Transform |
| 1 | `transformation/dbt_project.yml` | Materialize each new intermediate folder as a view, the same way `transfers` and `tokens` are views. | BJ Transform |
| 1 | `orchestration/pipeline/schedules.py` | Add three daily cron lines, names below, each `0 6 * * *`, matching the existing pipelines. Jobs stay off until an analyst turns them on, which is how a new schedule already behaves. | BJ Orchestration |
| 1 | `orchestration/tests/test_definitions.py` | Assert each new mart's parents. The existing "every asset is in a scheduled pipeline" test then covers the new assets without a special case. | BJ Orchestration |
| 2 | `.claude/skills/blockjuice/references/question-spec.md` | Document a window key for an exclusive UTC end, and a slot or solidified-height range beside EVM blocks, so `bj answer` can name these inputs. | BJ Skills & Reports |
| 2 | `.claude/skills/blockjuice/workflows/report.md` | One short note: these answers use the claim ceilings in the three plans, and `bj report` copies `definitions` through unchanged. | BJ Skills & Reports |

`ingestion/sources.json` is not edited by hand. Each new package is followed by `pnpm generate-sources`, and that generated file is committed by BJ Ingestion with the package that caused it.

Pipeline names, one mart folder each:

| Pipeline key in `PIPELINES` | Mart folder |
|---|---|
| `ousd_concentration` | `transformation/models/marts/ousd_concentration/` |
| `usdc_supply` | `transformation/models/marts/usdc_supply/` |
| `usdt_panel` | `transformation/models/marts/usdt_panel/` |

## Quality Gate corrections, and where they went

| Correction | Where it is handled |
|---|---|
| OUSD identity, four addresses, Tempo chain id 4217 versus testnet 42431, six Tempo decimals as documentation | OUSD plan, Verified facts |
| April 24 versus September 30 are conflicting source dates, not first issuance | OUSD plan, Unresolved decisions. No model uses either date as a start. |
| HHI over all eligible holders, 0–1 scale, top-k uses `min(k, N)`, `D = 0` is null | OUSD plan, Accounting |
| Full ledger reconciles to supply before any exclusion. Custodians stay in the primary series. Exclusions are a sensitivity with a recomputed denominator | OUSD plan, Accounting |
| Solana metric is the historical authority owner. Unresolved owners block the owner-level mart. Unknown owners are not one bucket | OUSD plan, Accounting |
| Exclusive cutoff 2026-11-07 00:00 UTC. Pre-deployment days are null | OUSD plan, Accounting |
| Tempo: do not add Mint, Burn, and memo amounts on top of Transfer. Credit the ledger holder, including fee movements on a reverted application call, without booking the reverted application transfer or a fee twice | OUSD plan, Accounting. Fee and TIP-20 behaviour is documentation-verified on the pages fetched below, and the deployed bytecode is not |
| USDC window, B0/B1, post-state at B0−1 and B1−1, zero-to-zero rejected, integer base units | USDC plan, Accounting |
| Supply equality is not gross completeness. Same manifest for the check and the aggregate. No manufactured zero days | USDC plan, Gates. Shared manifest above |
| Eight static issues in the unexecuted SQL | USDC plan, Gates. The SQL file is not added to the repo |
| CCTP stays inside the totals with no cross-chain match | USDC plan, Non-goals |
| TRON panel blocked until comparable accounting, ordered stages, labels, owner versus address, units, and token-specific supply rules exist | USDT plan. The rules are written as a proposal. The status line stays blocked |
| Share is TRON volume over the three-chain sum. Whole-window share is a ratio of sums. A missing chain makes the share null | USDT plan, Accounting |
| Decimal-normalized token units. No USDC zero-address rule copied onto USDT | USDT plan, Accounting |
| Consolidated gate: immutable manifest, canonical ranges, state reconciliation and samples, finality, query version, unknown is not a pass | Shared rules 6–7 and each plan's Gates |

## Unresolved decisions for Ian

These stay open in this pull request.

1. **Provenance exception.** Approve or reject the `ingestion/lib` manifest writer in the shared table. Rejecting it leaves `bj coverage` as a check of the files as they are today, which does not meet the Quality Gate's same-snapshot rule. The three pipelines wait either way until this is decided.
2. **OUSD first issuance, per chain.** Resolve on chain: deployment transaction, earliest successful positive issuance, canonical block or slot, timestamp, and any opening allocation. Token Terminal's fetched page says launch 24 April 2026. Bridge's fetched announcement is dated 30 September 2026 and says Open USD launched that day. Neither date is a verified first mint. The plans do not pick one.
3. **Base finality.** Portal's finalized head is what EVM stream sources already use. Confirm that this is the cutoff an analyst should publish for Base OUSD, or name a stricter rule. The plans do not invent an L1 block lag.
4. **Tempo origin.** The fetched Portal dataset list has no Tempo dataset. Name the history origin, the RPC an analyst is allowed to use, and the finality rule for chain id 4217. The same address on chain id 42431 is testnet and is out of the ledger.
5. **TRON panel.** The third plan is blocked as specified. Approve or replace the chain set, the five stages, the label confidence threshold, and the treatment of unresolved Solana owners. Until that approval, no TRON, Ethereum USDT, or Solana USDT source is in scope to build.
6. **OUSD eligible-denominator list.** The primary series is the full ledger. The sensitivity that drops zero and burn addresses needs an explicit address list per chain, after supply reconciliation shows those balances. Ian confirms the list. It is not "every address that looks dead."
7. **USDT fee leg and confiscation, once code is verified.** The public `TetherToken.sol` fetched from GitHub's default branch shows a fee split and `destroyBlackFunds` that emits `DestroyedBlackFunds` rather than a zero-address `Transfer`. That file's header says it was submitted to Etherscan on 2017-11-28. It is not proof of the bytecode at the Ethereum address during October 2026. Ian confirms, after the catalog proof, whether a fee leg is its own transfer in S2.

## Dependencies an analyst will hit

- Archive state for historical `totalSupply`, `decimals`, implementation, and `balanceOf` samples. The balance package comment says a past block needs an archive node. No archive endpoint is named in this plan.
- A Solana history decoder. Portal lists `solana-mainnet`. This repo never imports a Solana stream. `ingestion/lib/src/solana/` reads current RPC state.
- A TRON decoder. Portal lists `tron-mainnet`. This repo has no TRON client.
- A Tempo origin. Missing from the fetched Portal list and from `bj blocks` and eRPC.
- Label pages with a URL and an evidence date, collected when implementation starts. This pull request collects none.
- `answers/` is gitignored. The analyst UX is specified here and materialises only after a pipeline exists.

## Out of scope for the whole batch

- Engineering A–H.
- Editing `ingestion/sources/evm-erc20-transfers/`, `analytics.erc20_transfers`, or `analytics.classified_transfers`.
- Origin Dollar, or any other token that shares the letters OUSD.
- USDC on any chain except Ethereum. Circle's directory lists other USDC addresses; they are not this question.
- USDT outside TRON, Ethereum, and Solana. Tether's directory lists other protocols; they are not this panel.
- Bridged representations, including Tempo USDC.e and pathUSD, except where a Tempo OUSD fee is actually paid in OUSD.
- Cross-chain identity merges, CCTP matching, treasury-adjusted circulation, prices, and dollar volume.
- Implementing, backfilling, or scheduling any of this before the decisions above and a Quality Gate review of this pull request.

## Public pages fetched for this plan (2026-11-07)

Documentation identity was re-read. Deployed bytecode, authorities, and historical state were not.

- https://apidocs.bridge.xyz/overview
- https://www.bridge.xyz/blog/ousd-is-live-issued-by-bridge
- https://tempo.xyz/developers/docs/guide/ousd
- https://tempo.xyz/developers/docs/protocol/tip20/spec
- https://tempo.xyz/developers/docs/protocol/fees/spec-fee
- https://tokenterminal.com/explorer/projects/openstandard/openusd
- https://developers.circle.com/stablecoins/usdc-contract-addresses
- https://developers.circle.com/cctp
- https://tether.to/en/supported-protocols/
- https://raw.githubusercontent.com/tethercoin/USDT/main/TetherToken.sol
- https://portal.sqd.dev/datasets
