# Stablecoin briefs: implementation plans (docs only)

**For:** Ian  
**From:** BJ Pipeline Implementation Planner, through BJ Team Lead  
**Date:** 2026-11-07  
**Planning snapshot:** `def118f29d45011a8a501f953d06aa430bf54c79` (after the analyst snapshot `c8b72aef02c676348df290e29ca33c76545638e0`). Source, cursor, and mart statements below were read on that commit.  
**Live main when this revision was written:** `a726d9f2295d6badc555659b398bd17c61b3020c`. `git diff --stat def118f...a726d9f` is `.github/workflows/ci.yml`, a CI badge in `README.md`, and a short CI paragraph in `docs/architecture.md`. That commit does not change `ingestion/sources.json`, the transfer source, `_sync`, or the marts cited here. CI, as that paragraph describes it, does not reach a chain, an RPC, or Portal. Before implementation, re-read the cited paths on the merge-base in use. This revision did not reopen those source files on `a726d9f`.  
**Mode:** Documentation only. No source, model, schedule, or warehouse change ships in this pull request.  
**Review:** Quality Gate returned FAIL for plans-only readiness at `1ab97f1`. This revision specifies that review's F1–F4. It is still a draft. It is not a Quality Gate pass, not a data finding, and not permission to build.

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

Between the analyst snapshot `c8b72ae` and the planning snapshot `def118f`, the diff is nine files: Binance and Coinbase vendor catalog entries, two one-line source comments, and small edits to `docs/architecture.md`, `CLAUDE.md`, and `.claude/skills/blockjuice/SKILL.md`. None of those files add a chain, a token filter, a cursor, or a mart used by these three questions.

## Repo facts that shape all three plans

These are facts about files. They are not chain findings.

| Fact | Where it was read |
|---|---|
| Sources, dbt, and Dagster are the three layers. A mart is one kind of fact for every chain it covers. A pipeline is one mart folder plus its upstream, one Dagster job, one cron line in `PIPELINES`. | `docs/architecture.md`, `GLOSSARY.md`, `orchestration/pipeline/schedules.py` |
| `ingestion/sources.json` lists the committed sources. There is no TRON source and no Tempo source. Solana entries are `solana.sol_balances` and `solana.spl_balances` only. | `ingestion/sources.json` |
| EVM history is a Pipes stream. `portalClient` sets `finalized: true`. `finalizedHead` returns a block number, not a hash. The range targets that number. `upTo` ends the run on the batch that passes `maxBlocksPerRun` (default 1,000,000), so a run can commit a cursor short of the head. The cursor lives in `raw._sync` and commits with the batch. The next run resumes after that cursor. A stream source has no dead letters. The string `finalized` on the client is not evidence that a particular extract is historically final. | `ingestion/lib/src/portal.ts`, `ingestion/lib/src/warehouse/stream.ts`, `ingestion/lib/src/source.ts`, `ingestion/lib/src/run/index.ts` |
| `bj coverage` reports `START_BLOCK` through the cursor for the `addresses.json` it reads now. The history workflow states that coverage assumes the filter has not changed since `START_BLOCK`. Widening a filter and resuming does not load the omitted history. A reset deletes the `_sync` row and truncates the raw table. | `orchestration/pipeline/cli/coverage.py`, `.claude/skills/blockjuice/workflows/history-source.md` |
| Ethereum ERC-20 transfers are wallet-filtered. `chains/ethereum/addresses.json` lists three wallets and USDC, USDT, and DAI. It does not list OUSD. The package comment and test show that a transfer touching none of the wallets is dropped. The checked-in `START_BLOCK` comment says `26316189` is the first block of 2026-11-01 UTC. That comment was not re-checked against a block header in this pass. | `ingestion/sources/evm-erc20-transfers/chains/ethereum/addresses.json`, `ingestion/sources/evm-erc20-transfers/chains/ethereum/.env.example`, `ingestion/sources/evm-erc20-transfers/src/source.ts`, `ingestion/sources/evm-erc20-transfers/src/source.test.ts` |
| Base and Arbitrum transfer folders list a single UNI token and no `wallets` key, so those chains load every Transfer of that token. OUSD is not listed. Base `START_BLOCK` comment says `52011727` is the first block of 2026-10-01 UTC. That comment was not re-checked against a block header. | `ingestion/sources/evm-erc20-transfers/chains/base/addresses.json`, `chains/base/.env.example`, `chains/arbitrum/addresses.json` |
| `analytics.erc20_transfers` unions Ethereum, Arbitrum, and Base. `analytics.classified_transfers` labels a zero-address side as `bridge`. That rule is the transfers pipeline's category, and these plans do not reuse it as a mint or burn definition. | `transformation/models/marts/transfers/erc20_transfers.sql`, `classified_transfers.sql` |
| ERC-20 balances and metadata are call sources. `BLOCK_NUMBER` accepts a block number or `latest`, `safe`, or `finalized`. The metadata source keys each record by block and token, so a pinned block is a historical call it can store. The checked-in metadata example sets `BLOCK_NUMBER=latest`. The balance example sets `finalized`. `analytics.tokens` keeps the latest reading per chain and token. That mart is not a per-interval metadata series. The metadata source does not read `totalSupply` or implementation. A null `decimals` stays null. | `ingestion/lib/src/evm/env.ts`, `ingestion/sources/evm-erc20-metadata/src/source.ts`, `ingestion/sources/evm-erc20-metadata/.env.example`, `ingestion/sources/evm-erc20-balances/.env.example`, `transformation/models/marts/tokens/tokens.sql` |
| Solana SPL balances read `getTokenAccountsByOwner` at the latest finalized slot for three wallets and three mints, one of which is the Tether Solana mint. The client comment says Solana RPCs serve current state and do not take a historical slot. Amounts are summed across token accounts for that current call. There is no instruction history, no owner history, and no OUSD mint in that file. | `ingestion/lib/src/solana/client.ts`, `ingestion/sources/solana-spl-balances/src/source.ts`, `src/balances.ts`, `addresses.json` |
| Solana addresses are case-sensitive and are not lowercased. EVM staging lowercases addresses. | `ingestion/lib/src/solana/address.ts`, `transformation/models/staging/ethereum/stg_ethereum__erc20_transfers.sql` |
| `bj blocks` knows eleven EVM Portal datasets, including `ethereum-mainnet` and `base-mainnet`. It has no Solana, TRON, or Tempo entry. | `orchestration/pipeline/cli/blocks.py` |
| eRPC aliases in this repo are ethereum, arbitrum, base, and solana. | `infra/erpc/erpc.yaml` |
| A Portal dataset list fetched on 2026-11-07 includes `ethereum-mainnet`, `base-mainnet`, `solana-mainnet`, and `tron-mainnet`. No dataset name in that list contains `tempo`. | `GET https://portal.sqd.dev/datasets` |
| Raw rows are `id`, `data` jsonb, `_loaded_at` timestamptz. Bigints are written as strings because jsonb numbers lose precision past 2^53. `write` drops duplicate ids in a batch by keeping the last (`uniqueBy`) and `INSERT ... ON CONFLICT DO UPDATE` replaces `data`. A test that runs after that write cannot recover the replaced payload. Staging casts transfer `value` to `numeric` and `timestamp` to `timestamptz`. | `ingestion/lib/src/warehouse/index.ts`, `stg_ethereum__erc20_transfers.sql` |
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
5. **Finality is per chain and is stored as two numbers.** A run targets Portal's finalized head and may stop earlier under the block cap. The extract stores `target_head_number` (what `finalizedHead` returned at run start) separately from `cursor_number` and `cursor_hash` (the `_sync` row of the last committed batch). Publication needs the union of committed batches to cover the required end. It does not need each run to have reached the head. Base uses the same Portal flag on `base-mainnet`; this repo does not define an extra L1 challenge-period cutoff, and a sequencer head is not the cutoff. Solana history, once built, stops at a finalized slot. TRON history, once built, stops at a solidified block. Tempo has no Portal dataset in the fetched list, so its finality rule is decision 4.
6. **Checks and aggregates read one versioned extract.** Run ids do not freeze `raw`. The boundary is specified under [Shared input boundary](#shared-input-boundary). `opening + mints − burns = closing` is necessary and does not prove that omitted mints and omitted burns cancelled.
7. **Chain rules stay in per-chain intermediates.** `int_<chain>_*` applies that chain's owner, fee, or supply rule. The mart unions those models into one shape. Tempo fee rules and Solana owner rules do not share one intermediate file. [layers.md](../../../.claude/skills/blockjuice/references/layers.md) is the pattern.
8. **Addresses are ledger units.** An EVM or TRON unit is an address. A Solana unit for concentration and for owner-self is the token-account authority owner effective at that instruction under [Solana owner intervals](#solana-owner-intervals), summed across that owner's token accounts. Neither unit is a person, a wallet user, or adoption.
9. **Claim ceiling.** Each answer states the rule version, the chain, and the window. It does not state fiat inflows, liquidity, unique people, beneficial ownership, retail payments, economic settlement, wash trading, or a bound on a figure that came from somewhere else.
10. **A failed build is not a publication lock that already exists.** The status-model contract is under [What an analyst sees](#what-an-analyst-sees). These plans specify it. They do not implement it.

## Shared input boundary

Run ids do not freeze inputs. `ops.ingestion_runs` and a shared `dagster_run_id` name executions. They do not lock `raw.*`. `write` replaces `data` on key conflict. A stream batch commits with the cursor before the run row is written, and a later run resumes after that cursor. Matching ids under one Dagster run is not the same snapshot.

**The boundary is a versioned extract.** dbt already chooses its raw schema with `RAW_SCHEMA` (`transformation/models/staging/ethereum/_ethereum__sources.yml`). No new control plane.

1. BJ Orchestration opens one Postgres transaction at `REPEATABLE READ`.
2. Inside it, for every raw table the pipeline names, copy `id`, `data`, and `_loaded_at` into a new schema `extract_<extract_id>` (hyphens stripped so it is a schema name). Table names stay `ethereum_usdc_transfers` and the other raw names, so staging `identifier`s do not change. Copy `_sync`, the batch-log rows for that generation, and the dead-letter rows for those sources into the same schema.
3. Commit. `extract_id` is a uuid. The schema is insert-only. A later raw upsert, truncate, or cursor move does not change it.
4. The check and the aggregate for that answer both run with `RAW_SCHEMA=extract_<extract_id>`. That is the switch staging yml already has. A model that reads `raw` fails the check.
5. `ops.extracts` stores `extract_id`, pipeline, `rule_version`, git sha, dbt `invocation_id`, `dagster_run_id`, and, after the build, the check outcomes copied from `ops.dbt_node_runs` for that invocation. A missing outcome stays `unknown` and fails closed. Child rows in `ops.extract_sources` store, per source: the in-memory config hash, chain, token, implementation identifiers present in the copied supply rows, `target_head_number`, `cursor_number`, `cursor_hash`, the batch id list, and the expected state-call ids.

**Contributing runs.** `ops.source_batches` is inserted in the same transaction as the raw rows and the cursor:

| Column | Meaning |
|---|---|
| `run_id`, `batch_seq` | The run and the batch inside it. A failed run keeps the batches that committed. |
| `from_number`, `to_number`, `to_hash` | The range this batch committed. `to_hash` is the cursor hash Pipes stored, not a hash invented from `finalizedHead`. |
| `record_count` | Rows handed to `write` after the conflict guard. |
| `filter_sha256`, `config_sha256` | Hash of the address list and event list already parsed in memory. The writer does not read `addresses.json` a second time. |
| `generation` | Increments when an operator truncates the raw table and deletes `_sync`. |

The extract lists every batch whose range intersects the published window, from every run, including a run whose final status is failed.

**Partial failure and resume.** A batch that commits stays attributed if `runSource` then throws. The run row is still written, with `succeeded = false` and `committed_through` equal to the last committed batch. The next run has a new `run_id` and resumes after the cursor. Coverage is the union of the batches. A gap (`from_number` of the next batch is not `to_number + 1` of the previous) fails the extract. A capped run that stops short of `target_head_number` is a partial advance. Publication waits until the union covers the required end.

**Reload and a changed filter.** Truncate-and-reset starts a new `generation`. The extract copies one generation. If any copied batch's `filter_sha256` differs from the extract's declared hash, status is `fail`. The file on disk at build time is not used to replace that hash. Two extracts under one Dagster run get two `extract_id`s. The mart carries one. A check fails when it is not the id recorded for that dbt invocation.

**State calls.** The pipeline declares the expected `callId` set before the run (boundary blocks, samples, receipts). Completeness means each expected id has one successful record in the extract and is absent from the copied pending and parked dead letters. Zero dead letters with a missing expected id is `fail`: the call was never attempted. Dead-letter emptiness is not completeness. The call log uses the same in-memory hash of the expected list.

**Decision 1 is only this write.** [layers.md](../../../.claude/skills/blockjuice/references/layers.md) says a new source does not change `ingestion/lib`, `runSource`, or the `Source` contract. Ian approves or rejects this exception. Scope, if approved:

- `ingestion/lib/src/warehouse/stream.ts`: inside the existing Pipes transaction, insert one `ops.source_batches` row. Pass in the hashes already computed by the source.
- `ingestion/lib/src/run/index.ts`: thread `run_id` and those hashes into that transaction. On failure, still write the run row pointing at committed batches. Do not re-read `addresses.json` in `finally`.
- `ingestion/lib/src/warehouse/index.ts`: the batch-log insert used by that transaction. Decision 1 does not change `uniqueBy` or `ON CONFLICT DO UPDATE`. That change is decision 8.
- No edit to the `Source` or `StreamSource` types. No Solana, TRON, or Tempo decoder in `lib`. Decoding stays in the source package.

Rejecting decision 1 means there is no publishable extract. Approving it does not approve decoders, and it does not by itself satisfy the conflict rule in decision 8.

**Fixtures for this boundary.** They are acceptance tests, not measured results:

1. Raw rows change after the copy and before the aggregate. Measures still match the extract.
2. One `dagster_run_id`, two extracts. The mart's `extract_id` is the invocation's id. The other extract's rows are absent.
3. One batch commits, the run then throws, a later run resumes. Both batches are listed. A planted gap fails.
4. A later batch carries a different `filter_sha256` while the cursor only moves forward. Status is `fail`.
5. An expected supply `callId` is absent and the dead-letter count is zero. Status is `fail`.

## Header time before a day filter

A non-null `timestamptz` is not a correct timestamp. Before any date predicate, on the extract:

- Load a header row for every cited block or produced slot: canonical hash and header time as `timestamptz`. Solana slots are marked `produced` or `skipped`.
- Join each event on network, height, and hash. The event time must equal the header time. Inequality fails the extract. The row is kept in the conflict/status sense: it is not dropped and not moved into another day.
- A null network, null canonical hash, null transaction id, or null log index or instruction path fails before the date filter.
- A Solana skipped slot has no block time and cannot hold an event. An event that cites one fails the extract.
- A produced slot with a null block time is **unassigned**. It stays in the extract and on the status model as `unassigned`. It is not placed in a daily group.
- Affected scope: if verified neighboring produced slots bracket that slot with times `T0` and `T1`, every UTC date that intersects `[T0, T1]` is `fail`, and the whole requested window is `fail`, because a window sum cannot omit that amount. If no bracket is proved, every scope in the requested window is `fail`. The unassigned row remains visible. It does not vanish from the status model.

Fixtures: a non-null time that disagrees with the header; a null time; a time equal to the exclusive cutoff `2026-11-07 00:00:00Z`; an unassigned Solana slot that is absent from every daily group. The last fixture fails unless the status model still shows the unassigned amount.

## Conflicting payloads

Current `write` keeps the last duplicate in a batch and overwrites `data` on conflict. A singular test after that load cannot see the lost payload. The production guard, for the new sources only, runs inside `write` before the insert. It is implementation-blocking until decision 8. A package unit test is not a substitute.

- Same `id` and byte-identical `data`: one row. A repeat in a later run does not change `data` and does not fail.
- Same `id` and different `data`, in one batch or against a row already stored: do not update `raw.data`. Insert both payloads into `ops.source_conflicts` (insert-only, its own commit) and roll back the batch transaction. The cursor does not advance. A previous raw payload stays where it was.
- Existing pipelines keep today's `write`. New sources pass `onConflict: 'preserve'`. That flag is the whole of decision 8. It is not included in decision 1.

Identity fields required non-null before a window filter: network, canonical hash, transaction id, and log index or instruction path. Amount text matches `^[0-9]+$`. `NaN`, `Infinity`, a fraction, and exponent notation fail as text, before a `numeric` cast. A cast-and-truncate check is not this gate.

Fixtures: same-batch conflict; a later run with a different payload for an existing id; a null transaction id; a null log index.

## Solana owner intervals

Slot-level owner is not enough. A slot can hold several ordered authority changes, including more than one in a single transaction.

Order key, lowest first: `(slot, transaction_index, outer_instruction_index, inner_path)`. `transaction_index` is the canonical transaction order in the slot. `inner_path` is empty on an outer instruction.

Lifecycle key: `(mint, token_account)`.

Walk that order:

- Initialize sets the owner from that instruction. Earlier instructions in the lifetime have no owner.
- `SetAuthority` for the account owner applies to **later** instructions. The `SetAuthority` instruction is not a transfer. Instructions before it, including earlier ones in the same transaction, keep the previous owner.
- Close ends the lifetime at that instruction. A later initialize of the same pubkey starts a new lifetime and does not inherit the old owner.
- A transfer uses the owner effective after every earlier instruction and before the transfer itself.

A null order field sets `owner_status = unresolved` and blocks owner-level metrics and owner-self removal.

Fixtures, in both the OUSD and USDT plans. Until a catalog proof transaction exists, the fixture is a synthetic ordered list labeled as a specification fixture, not as something observed on chain:

1. One transaction: transfer, `SetAuthority`, transfer. The first transfer uses the old owner. The second uses the new owner. They are not owner-self with each other.
2. One slot, two transactions. Transaction 0: transfer, then `SetAuthority`. Transaction 1: transfer. A join on slot alone, labeling both transfers with the last owner, fails the fixture.
3. Close, then initialize the same token-account pubkey with a new owner, then transfer. The transfer uses the new lifetime.

## What an analyst sees

Two models, both in the pipeline's mart folder:

- `*_status`: one row per expected chain and day, or per panel scope. `coverage_status` is `pass`, `fail`, or `unknown`. Measures are null unless status is `pass`. Unassigned amounts sit on this model.
- The published mart: `pass` rows only. A `fail` or `unknown` day is a **missing mart row**. It is not a row of zeros and not a row of null measures inside the published mart.

A dbt test that fails the build is the specified enforcement. This pull request does not add that test. A green Dagster run is not the enforcement either. `bj answer` is specified to refuse `answer.json` when the invocation's tests are not `pass` for that `extract_id`. That refusal is not implemented for these pipelines yet.

## Shared phased changes

These files serve more than one pipeline. Each has one owner. Pipeline files are listed in that pipeline's plan.

| Phase | Path | Change | Owner |
|---|---|---|---|
| 0 | `infra/postgres/ops.sql` | Add `ops.source_batches`, `ops.extracts`, `ops.extract_sources`, and `ops.source_conflicts`. Batches and conflicts are insert-only. | BJ Orchestration |
| 0 | `ingestion/lib/src/warehouse/stream.ts`, `ingestion/lib/src/run/index.ts` | Decision 1 only: same-transaction batch log, in-memory hashes, failed runs still point at committed batches. No `Source` type change and no decoder. | BJ Ingestion |
| 0 | `ingestion/lib/src/warehouse/index.ts` | Decision 1: the batch-log insert helper. Decision 8, separately: opt-in `onConflict: 'preserve'` before the existing upsert. Existing callers keep today's `write`. | BJ Ingestion |
| 0 | `ingestion/lib/src/run/run.test.ts`, `ingestion/lib/src/warehouse/stream.test.ts` | The five input-boundary fixtures, plus the same-batch and cross-run conflict fixtures. | BJ Ingestion |
| 0 | `orchestration/pipeline/extract.py` (new) and a call from the answer path | The `REPEATABLE READ` copy into `extract`. Reads the warehouse only. | BJ Orchestration |
| 0 | `transformation/models/staging/ops/` (new `_ops__sources.yml`, staging models for batches, extracts, conflicts) | Casts only. `timestamptz` stays `timestamptz`. | BJ Transform |
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
| Solana metric is the historical authority owner, in transaction and instruction order, with account lifetimes. Unresolved owners block the owner-level mart. Unknown owners are not one bucket | [Solana owner intervals](#solana-owner-intervals). OUSD and USDT plans |
| Exclusive cutoff 2026-11-07 00:00 UTC. Pre-deployment days are null | OUSD plan, Accounting |
| Tempo: do not add Mint, Burn, and memo amounts on top of Transfer. Credit the ledger holder, including fee movements on a reverted application call, without booking the reverted application transfer or a fee twice | OUSD plan, Accounting. Fee and TIP-20 behaviour is documentation-verified on the pages fetched below, and the deployed bytecode is not |
| USDC window, B0/B1, post-state at B0−1 and B1−1, zero-to-zero rejected, integer base units | USDC plan, Accounting |
| Supply equality is not gross completeness. Checks and aggregates read one versioned extract. No manufactured zero days | [Shared input boundary](#shared-input-boundary). USDC plan, Gates |
| Eight static issues in the unexecuted SQL | USDC plan, Gates. The SQL file is not added to the repo |
| CCTP stays inside the totals with no cross-chain match | USDC plan, Non-goals |
| TRON panel blocked until comparable accounting, ordered stages, labels, owner versus address, units, and token-specific supply rules exist | USDT plan. The rules are written as a proposal. The status line stays blocked |
| Share is TRON volume over the three-chain sum. Whole-window share is a ratio of sums. A missing chain makes the share null | USDT plan, Accounting |
| Decimal-normalized token units. No USDC zero-address rule copied onto USDT | USDT plan, Accounting |
| Consolidated gate: one immutable extract, canonical ranges, header times, state-call completeness, finality evidence separate from the cursor, query version, unknown is not a pass | [Shared input boundary](#shared-input-boundary), [Header time before a day filter](#header-time-before-a-day-filter), each plan's Gates |

## Unresolved decisions for Ian

These stay open. Local decisions in the three plans use the same numbers. F1–F4 are specified in this file. Decisions 1 and 8 are still implementation-blocking: the specification is not approval to edit `ingestion/lib`.

1. **Batch-log exception.** Approve or reject the narrow `ingestion/lib` write in [Shared input boundary](#shared-input-boundary). Two hashes and a run id do not freeze inputs. Rejecting this leaves no versioned extract. Approving it does not add a decoder and does not change upsert behavior.
2. **OUSD first issuance, per chain.** Resolve on chain: deployment or init transaction, earliest successful positive issuance, canonical block or slot and time, and any opening allocation or migration. Product launch is a separate date. Token Terminal's fetched page says launch 24 April 2026. Bridge's fetched announcement is dated 30 September 2026 and says Open USD launched that day. Neither date is a verified first mint.
3. **Base finality.** Portal's finalized head is what EVM stream sources already target. Confirm that this is the cutoff an analyst should publish for Base OUSD, or name a stricter rule and the canonical evidence that proves it. A sequencer head, or the word "finalized" alone, is not that evidence. This plan does not invent an L1 block lag.
4. **Tempo origin.** The Portal dataset list fetched for the planning snapshot has no Tempo dataset. Name the history origin, the access an analyst is allowed to use, and the finality rule for chain id 4217. The same address on chain id 42431 is testnet and is out of the ledger. This review pass did not re-fetch that dataset list.
5. **TRON panel.** The third plan is blocked as specified. Approve or replace the chain set, stages S1–S5, the label confidence threshold, and who may insert a label row (decision 12). Solana owner order is specified under [Solana owner intervals](#solana-owner-intervals); it is not waiting on this decision. Until panel approval, no TRON, Ethereum USDT, or Solana USDT source is in scope to build.
6. **OUSD eligible-denominator list.** The primary series is the full ledger. The sensitivity that drops zero and burn addresses needs an explicit address list per chain, after supply reconciliation shows those balances. Ian confirms the list. It is not "every address that looks dead."
7. **USDT fee leg, confiscation, and zero-address supply, after historical proof.** The fetched `TetherToken.sol` is a 2017 source file, not the October 2026 bytecode. It does not authorize an accounting rule. Both Ethereum logs are stored. Whether S2 sums a fee leg, and whether a transfer to the zero address changes supply, stay null until the catalog proof. TRON paths are proved on TRON, not copied from that file. A null `changes_supply` blocks publication. Absence of proof does not default it to false.
8. **Conflict guard. Implementation-blocking.** Approve or reject opt-in `onConflict: 'preserve'` in [Conflicting payloads](#conflicting-payloads). Existing sources stay on today's `write`. New pipelines are not built while this is open, because a post-load test cannot recover an overwritten payload.
9. **Optional OUSD token-account mart.** OUSD plan, local item 6. Owner-level HHI stays blocked while any authority owner is unresolved. A token-account mart would be a different unit and would not be compared with EVM address counts.
10. **Archive endpoint.** No archive provider is named. USDC plan, local item 4. Boundary `eth_call`s wait on a named endpoint. `BLOCK_NUMBER=finalized` on the balance source is a different block.
11. **USDC `rule_version` after catalog proof.** USDC plan, local items 2 and 3. Ian accepts the mint and burn paths, including any path that is not a zero-address `Transfer`. The plan does not assume that shape in order to publish.
12. **USDT label authority and confidence threshold.** USDT plan, local item 3. The evidence-date rule and the effective-interval rule are already specified and are stricter together than an effective interval alone: evidence must be dated on or before the movement, and the effective interval must cover it. A label published after the transfer does not apply because someone set `effective_from` earlier. The unpublished threshold means S4 and S5 remove nothing until Ian sets it.

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
