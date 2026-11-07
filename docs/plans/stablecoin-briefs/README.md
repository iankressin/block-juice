# Stablecoin briefs: implementation plans (docs only)

**For:** Ian  
**From:** BJ Pipeline Implementation Planner, through BJ Team Lead  
**Date:** 2026-11-07  
**Planning snapshot:** `def118f29d45011a8a501f953d06aa430bf54c79` (after the analyst snapshot `c8b72aef02c676348df290e29ca33c76545638e0`). Source, cursor, and mart statements below were read on that commit.  
**Live main when this revision was written:** `a726d9f2295d6badc555659b398bd17c61b3020c`. `git diff --stat def118f...a726d9f` is `.github/workflows/ci.yml`, a CI badge in `README.md`, and a short CI paragraph in `docs/architecture.md`. That commit does not change `ingestion/sources.json`, the transfer source, `_sync`, or the marts cited here. CI, as that paragraph describes it, does not reach a chain, an RPC, or Portal. Before implementation, re-read the cited paths on the merge-base in use. This revision did not reopen those source files on `a726d9f`.  
**Mode:** Documentation only. No source, model, schedule, or warehouse change ships in this pull request.  
**Review:** Quality Gate returned FAIL for plans-only readiness at `1ab97f1`. The next revision answered that review; the [corrections table](#quality-gate-corrections-and-where-they-went) maps each item. A second review on this pull request then changed the shared input boundary, the day-boundary check, and where the question windows live; those changes are listed under [Changes after the second review](#changes-after-the-second-review). It is still a draft. It is not a Quality Gate pass, not a data finding, and not permission to build.

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
| EVM history is a Pipes stream. `portalClient` sets `finalized: true`. `finalizedHead` returns a block number, not a hash. The range targets that number. `upTo` ends the run on the batch that passes `maxBlocksPerRun` (default 1,000,000), so a run can commit a cursor short of the head. The cursor lives in `raw._sync` and commits with the batch. The next run resumes after that cursor. A stream source has no dead letters. The string `finalized` on the client is not evidence that a particular load is historically final. | `ingestion/lib/src/portal.ts`, `ingestion/lib/src/warehouse/stream.ts`, `ingestion/lib/src/source.ts`, `ingestion/lib/src/run/index.ts` |
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
| Answers live in gitignored `answers/<slug>/`. `bj answer` compiles the question's analyses, runs the dbt tests upstream of them with `var('coverage')` set to what each stream source has loaded, and checks coverage, dead letters, and freshness for each input. It writes `answer.json` with the inputs' last successful run, the check outcomes, and provenance (`git_sha`, `git_dirty`, `dbt_version`), and exits 1 when a check fails. `bj report` builds xlsx, pdf, docx, and a Google Doc. | `.gitignore`, `.claude/skills/blockjuice/references/question-spec.md`, `orchestration/pipeline/cli/answer.py`, `.claude/skills/blockjuice/workflows/answer.md`, `docs/architecture.md` |
| `bj coverage` reads `current_number` from `_sync` and does not print `current_hash`. `bj blocks` resolves a UTC time to the first block at or after it by binary search over Portal block timestamps, for the EVM datasets it lists. | `orchestration/pipeline/cli/coverage.py`, `orchestration/pipeline/cli/blocks.py` |
| A check build already has its own schemas: the history workflow runs a short window with `RAW_SCHEMA` set to a check schema and `DBT_SCHEMA` set to a check analytics schema, so no check cursor or check mart lands in production. `profiles.yml` reads `DBT_SCHEMA`. | `.claude/skills/blockjuice/workflows/history-source.md`, `transformation/profiles.yml` |
| Portal returns a log with its block's `hash` and `timestamp`. The Uniswap sources write the transactions of their logs as records of their own, keyed by hash, and layers.md says to join them in dbt. An EVM log exists only when its transaction succeeded, so a reverted transaction has no log to collect. | `ingestion/sources/evm-uniswap-v3/src/source.ts`, `.claude/skills/blockjuice/references/layers.md` |

## Shared design rules

1. **New raw tables.** These questions need every log of a named contract. The checked-in Ethereum transfer source keeps its three wallets, its token list, its `START_BLOCK`, and its cursor. New packages write `raw.<chain>_<table>` of their own. Implementation does not delete `raw._sync` for `ethereum_erc20_transfers`.
2. **One contract system per raw table.** OUSD, USDC, and USDT do not share a stream. A failure or a reset on one token does not move the others' cursors.
3. **History in, rules in dbt.** Sources write decoded logs and pinned state calls. Mint classification, holder balances, HHI, shares, and labels are intermediate and mart work. Staging casts types and does not apply a business rule.
4. **No wallet filter on the new history sources.** A `wallets` key is a failed run, not an empty filter.
5. **Finality is per chain and is stored as two numbers.** A run targets Portal's finalized head and may stop earlier under the block cap. The answer records `cursor_number` and `cursor_hash` (the `_sync` row of the last committed batch) and, separately, Portal's finalized head for that dataset read when `bj answer` ran. The cursor at or below that head is the finality evidence; the string `finalized` on the client is not. Publication needs the cursor to cover the required end. It does not need any one run to have reached the head. Base uses the same Portal flag on `base-mainnet`; this repo does not define an extra L1 challenge-period cutoff, and a sequencer head is not the cutoff. Solana history, once built, stops at a finalized slot. TRON history, once built, stops at a solidified block. Tempo has no Portal dataset in the fetched list, so its finality rule is decision 4.
6. **Checks and aggregates read one build.** Run ids do not freeze `raw`. The mart and every gate run in one dbt invocation, and the answer records what that invocation read. The boundary is specified under [Shared input boundary](#shared-input-boundary). `opening + mints − burns = closing` is necessary and does not prove that omitted mints and omitted burns cancelled.
7. **Chain rules stay in per-chain intermediates.** `int_<chain>_*` applies that chain's owner, fee, or supply rule. The mart unions those models into one shape. Tempo fee rules and Solana owner rules do not share one intermediate file. [layers.md](../../../.claude/skills/blockjuice/references/layers.md) is the pattern.
8. **Addresses are ledger units.** An EVM or TRON unit is an address. A Solana unit for concentration and for owner-self is the token-account authority owner effective at that instruction under [Solana owner intervals](#solana-owner-intervals), summed across that owner's token accounts. Neither unit is a person, a wallet user, or adoption.
9. **Claim ceiling.** Each answer states the rule version, the chain, and the window. It does not state fiat inflows, liquidity, unique people, beneficial ownership, retail payments, economic settlement, wash trading, or a bound on a figure that came from somewhere else.
10. **A failed build is not a publication lock that already exists.** The status-model contract is under [What an analyst sees](#what-an-analyst-sees). These plans specify it. They do not implement it.
11. **Marts are open-ended. Windows live in analyses.** A mart in this batch is a daily series over every day its sources cover, rebuilt on its schedule like the existing marts. The question's window and its exclusive cutoff are applied in `transformation/analyses/<question>.sql` and recorded in `question.yaml`, which is where [layers.md](../../../.claude/skills/blockjuice/references/layers.md) puts one question's filter. A mart does not hard-code a date, a block number, or a 30-day spine. A later question over the same token reuses the mart with a different window.

## Shared input boundary

Run ids do not freeze inputs. `ops.ingestion_runs` and a shared `dagster_run_id` name executions. They do not lock `raw.*`. `write` replaces `data` on key conflict. A stream batch commits with the cursor before the run row is written, and a later run resumes after that cursor. Matching ids under one Dagster run is not the same snapshot.

Two boundaries were specified. The first is the default these plans build on. The second is kept as the alternative Ian may choose instead. It is heavier, it changes `ingestion/lib`, and it is the only reason decisions 1 and 8 exist.

### Default: one build, recorded on the answer

What the repo already guarantees, and what this default relies on:

- A stream source reads finalized blocks only (`portalClient` sets `finalized: true`; `pipesTarget` sets `requiresFinalizedStream`), and every record is keyed by its place in the chain. A rerun of a finalized range writes the same bytes to the same key. A different payload at a finalized position would be a Portal defect, not an expected event. The supply identity and the balance samples are what would surface it.
- Raw rows are not edited after load ([layers.md](../../../.claude/skills/blockjuice/references/layers.md)). A reset is the one destructive operation. It is a deliberate operator action, and it shows as a cursor that moved backwards and a truncated table.
- `bj answer` already runs the dbt tests upstream of the question's analyses in one invocation, passes `var('coverage')` so reconciliation tests read only loaded blocks, checks coverage, dead letters, and freshness, records `git_sha`, and exits 1 when a check fails.

The boundary for an answer is one dbt invocation, built from `raw` into `analytics`, in which the mart and every gate in the three plans run together, plus the manifest `bj answer` writes into `answer.json`:

| Field | Where it comes from | Exists today |
|---|---|---|
| `git_sha`, `git_dirty`, `dbt_version` | `provenance()` in `answer.py` | yes |
| `checks`: dbt tests, coverage, dead letters, freshness | `bj answer` | yes |
| per history input: `start_block`, `cursor_number`, `filter` | `bj coverage` | yes |
| per history input: `cursor_hash` | `_sync.current_hash`, which `bj coverage` does not print yet | no, Orchestration adds it |
| per history input: Portal's finalized head at answer time | the Portal client `bj blocks` already uses, read once per dataset | no, Orchestration adds it |
| per state input: the expected `callId` list and the ids present | the call source's staging model and `_dead_letters` | no, a dbt test per pipeline |
| `dbt_invocation_id` | the test invocation `dbtRunner` returns; the marts also store dbt's `invocation_id` as a column | no, Orchestration adds it |
| `rule_version` | a column on the mart, copied into the answer | no, part of each mart |

Publication rule: `bj answer` already exits 1 when a check fails. For these pipelines the checks that must pass are the dbt gates listed in each plan, coverage through the window's last block per chain, cursor at or below Portal's finalized head at answer time, and every expected `callId` present. The analyst-facing enforcement is that exit code plus the pass-only marts. A green Dagster run is not the enforcement.

What this default does not give: a byte-for-byte copy of the raw rows at build time. If an operator resets a source after the build, a later `bj answer` on the same question shows a cursor that no longer matches the recorded `cursor_number` and `cursor_hash`. That is detection after the fact, not prevention. It is the trade this default makes, and it is the same trade every existing pipeline in the repo already makes.

Nothing in the default edits `ingestion/lib`, `runSource`, the `Source` contract, or the write path. The scheduled daily job builds from `raw` into `analytics` exactly like the existing pipelines, and it is the same build `bj answer` tests.

### Alternative: a versioned extract (decisions 1 and 8)

Kept so Ian can choose it with its costs visible. dbt chooses its raw schema with `RAW_SCHEMA` and its target schema with `DBT_SCHEMA` (`profiles.yml`), the pair the history workflow already uses for a check build.

1. BJ Orchestration opens one Postgres transaction at `REPEATABLE READ`.
2. Inside it, for every raw table the pipeline names, copy `id`, `data`, and `_loaded_at` into a new schema `extract_<extract_id>` (hyphens stripped so it is a schema name). Table names stay `ethereum_usdc_transfers` and the other raw names, so staging `identifier`s do not change. Copy `_sync`, the batch-log rows for that generation, and the dead-letter rows for those sources into the same schema.
3. Commit. `extract_id` is a uuid. The schema is insert-only. A later raw upsert, truncate, or cursor move does not change it.
4. The check and the aggregate for that answer both run with `RAW_SCHEMA=extract_<extract_id>` **and** `DBT_SCHEMA=analytics_extract_<extract_id>`. The scheduled daily job keeps building from `raw` into `analytics` and is not the answer build. Without the second variable the extract build would overwrite the production mart, and the next scheduled run would overwrite it back.
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

**State calls, under either boundary.** The pipeline declares the expected `callId` set before the run (boundary blocks, supply checkpoints, samples). Completeness means each expected id has one successful record in the build and is absent from the pending and parked dead letters. Zero dead letters with a missing expected id is `fail`: the call was never attempted. Dead-letter emptiness is not completeness. Under the default this is a dbt test over the call source's staging model and `_dead_letters`; under the extract the call log also stores the in-memory hash of the expected list.

**Decision 1 is this write, and it is a contract change.** [layers.md](../../../.claude/skills/blockjuice/references/layers.md) says a new source does not change `ingestion/lib`, `runSource`, or the `Source` contract. The batch log needs the source to hand `runSource` the hashes of the address list and event list it parsed, and the head it targeted. Today `runSource` sees none of those: the source computes them inside `stream(env)`. So approving decision 1 approves an optional field on `StreamSource` that returns them, alongside the edits below. Scope, if approved:

- `ingestion/lib/src/source.ts`: one optional field on `StreamSource` for the hashes and the targeted head. Existing sources do not set it.
- `ingestion/lib/src/warehouse/stream.ts`: inside the existing Pipes transaction, insert one `ops.source_batches` row from those values.
- `ingestion/lib/src/run/index.ts`: thread `run_id` and those values into that transaction. On failure, still write the run row pointing at committed batches. Do not re-read `addresses.json` in `finally`.
- `ingestion/lib/src/warehouse/index.ts`: the batch-log insert used by that transaction. Decision 1 does not change `uniqueBy` or `ON CONFLICT DO UPDATE`. That change is decision 8.
- No Solana, TRON, or Tempo decoder in `lib`. Decoding stays in the source package.

Rejecting decision 1 means the default boundary above is the boundary. Approving it does not approve decoders, and it does not by itself satisfy the conflict rule in decision 8.

**Fixtures for this boundary.** They are acceptance tests, not measured results, and they apply only when the alternative is chosen:

1. Raw rows change after the copy and before the aggregate. Measures still match the extract.
2. One `dagster_run_id`, two extracts. The mart's `extract_id` is the invocation's id. The other extract's rows are absent.
3. One batch commits, the run then throws, a later run resumes. Both batches are listed. A planted gap fails.
4. A later batch carries a different `filter_sha256` while the cursor only moves forward. Status is `fail`.
5. An expected supply `callId` is absent and the dead-letter count is zero. Status is `fail`.

## Day boundaries before a day filter

A non-null `timestamptz` is not a correct timestamp. But Portal hands a log its block's `hash` and `timestamp` from the same block header, so a rule that "the event time must equal the header time" compares a Portal value with itself when the header also comes from Portal. The independent evidence is a header read from a second origin, and it is only needed at the day boundaries, because block timestamps never decrease with height.

- **Boundary blocks.** For each UTC midnight the question or the status spine names, `bj blocks` resolves the first block at or after it over Portal. A per-chain header call source then reads that block and the one before it over RPC through eRPC (`eth_getBlockByNumber`: number, hash, timestamp), one record per boundary block, keyed by block number. Portal and RPC must agree on hash and timestamp for both blocks, and the earlier block's time must be before midnight while the later one's is at or after it. Disagreement fails that boundary and every day it bounds.
- **Assignment by height.** Inside a proved pair of boundaries, an event belongs to day `d` when its block number is in `[B_d, B_{d+1})`. Rows are not binned by comparing their own timestamp with a date. The day's closing block is `B_{d+1} − 1`.
- **Solana.** Slots are assigned the same way between boundary slots. The boundary read is `getBlockTime` over RPC for the first produced slot at or after each midnight and the produced slot before it. A skipped slot has no block time and cannot hold an event. An event that cites one fails. A produced slot with a null block time inside the window is **unassigned**: it stays on the status model as `unassigned`, it is not placed in a daily group, and the day whose boundaries enclose it, plus the whole window, are `fail`, because a window sum cannot omit that amount. If the slot is not enclosed by proved boundaries, every scope in the window is `fail`.
- **TRON.** The boundary read is `getblockbynum` on the TRON HTTP API at the solidified boundary blocks. The method is written in the catalog NOTES when the proof is done.
- A null network, null canonical hash, null transaction id, or null log index or instruction path fails before the date filter.

Fixtures: a boundary block whose Portal and RPC headers disagree; an event in block `B_{d+1}` that a timestamp comparison would have put in day `d`; a boundary time equal to the exclusive cutoff; a null Solana block time; an unassigned Solana slot that is absent from every daily group. The last fixture fails unless the status model still shows the unassigned amount.

## Conflicting payloads

Current `write` keeps the last duplicate in a batch and overwrites `data` on conflict. A singular test after that load cannot see the lost payload.

**Under the default boundary** new sources use today's `write`. The record key is the position in the chain, the stream reads finalized blocks only, and a rerun writes identical bytes. A legitimate same-key conflict does not arise from the chain; the one way to produce one is a decoder change, which is a new `rule_version` and a reset. The gates that would surface a wrong payload are the supply identity and the balance samples.

**If Ian chooses the extract (decision 8)**, a guard runs inside `write` before the insert, for the new sources only:

- Same `id` and byte-identical `data`: one row. A repeat in a later run does not change `data` and does not fail.
- Same `id` and different `data`, in one batch or against a row already stored: do not update `raw.data`. Insert both payloads into `ops.source_conflicts` over a second connection, since the Pipes transaction on the first one is about to roll back, then roll back the batch. The cursor does not advance. A previous raw payload stays where it was.
- Existing pipelines keep today's `write`. New sources pass `onConflict: 'preserve'`. That flag is the whole of decision 8. It is not included in decision 1.
- **A stuck batch has an exit.** The next run refetches the same finalized range from Portal and hits the same conflict, so the cursor never moves on its own. The operator procedure is: read `ops.source_conflicts`, decide which payload is right, and either fix the decoder under a new `rule_version` and reset the source (a new `generation`), or accept Portal's current bytes with a one-off reset of that range. Nothing resolves a conflict automatically.

Identity fields required non-null before a window filter, under either boundary: network, canonical hash, transaction id, and log index or instruction path. Amount text matches `^[0-9]+$`. `NaN`, `Infinity`, a fraction, and exponent notation fail as text, before a `numeric` cast. A cast-and-truncate check is not this gate.

Fixtures, alternative only: same-batch conflict; a later run with a different payload for an existing id. Fixtures, either boundary: a null transaction id; a null log index.

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

**Verify before writing the decoder.** Two things may make the walk above a cross-check rather than the primary source of the owner. The SPL Token `Transfer` instruction names the source account's authority as one of its accounts, so the source-side owner (or delegate) is in the instruction itself. And Portal's Solana dataset documents per-transaction token balance records that carry the account's owner before and after the transaction. If the dataset serves those for `solana-mainnet`, the destination owner at the end of a transaction is read, not reconstructed, and only ordering inside one transaction (fixture 1) still needs the instruction walk. Implementation confirms the dataset's fields against a proof transaction and records in the catalog NOTES which path is primary. The three fixtures below hold under either path.

Fixtures, in both the OUSD and USDT plans. Until a catalog proof transaction exists, the fixture is a synthetic ordered list labeled as a specification fixture, not as something observed on chain:

1. One transaction: transfer, `SetAuthority`, transfer. The first transfer uses the old owner. The second uses the new owner. They are not owner-self with each other.
2. One slot, two transactions. Transaction 0: transfer, then `SetAuthority`. Transaction 1: transfer. A join on slot alone, labeling both transfers with the last owner, fails the fixture.
3. Close, then initialize the same token-account pubkey with a new owner, then transfer. The transfer uses the new lifetime.

## What an analyst sees

Two models, both in the pipeline's mart folder:

- `*_status`: one row per expected chain and day, or per panel scope. `coverage_status` is `pass`, `fail`, or `unknown`. Measures are null unless status is `pass`. Unassigned amounts sit on this model.
- The published mart: `pass` rows only. A `fail` or `unknown` day is a **missing mart row**. It is not a row of zeros and not a row of null measures inside the published mart.

A dbt test that fails the build is the specified enforcement. This pull request does not add that test. A green Dagster run is not the enforcement either. `bj answer` already exits 1 when a dbt test upstream of the question's analyses fails or a coverage, dead-letter, or freshness check fails. The gates in each plan are written as dbt tests so that existing exit code covers them. The additions to `bj answer` are the manifest fields listed under [Shared input boundary](#shared-input-boundary).

## Shared phased changes

These files serve more than one pipeline. Each has one owner. Pipeline files are listed in that pipeline's plan.

| Phase | Path | Change | Owner |
|---|---|---|---|
| 0 | `orchestration/pipeline/cli/coverage.py` | Also read and print `current_hash` from `_sync` beside `cursor`. | BJ Orchestration |
| 0 | `orchestration/pipeline/cli/answer.py` | Record per history input the cursor hash and Portal's finalized head at answer time (the client `blocks.py` already has), fail `coverage` when the cursor is above that head, and record the dbt test invocation id. No new check kinds beyond those. | BJ Orchestration |
| 0 | `ingestion/sources/evm-block-headers/` (new call source, `chains/ethereum/`, `chains/base/`) | Number, hash, and timestamp of each boundary block over RPC, keyed by block number, for the [day-boundary rule](#day-boundaries-before-a-day-filter). Shared by every EVM pipeline in this batch. | BJ Ingestion |
| 0, alternative only | `infra/postgres/ops.sql` | Add `ops.source_batches`, `ops.extracts`, `ops.extract_sources`, and `ops.source_conflicts`. Batches and conflicts are insert-only. | BJ Orchestration |
| 0, alternative only | `ingestion/lib/src/source.ts`, `ingestion/lib/src/warehouse/stream.ts`, `ingestion/lib/src/run/index.ts` | Decision 1: the optional `StreamSource` field, the same-transaction batch log, failed runs still pointing at committed batches. No decoder. | BJ Ingestion |
| 0, alternative only | `ingestion/lib/src/warehouse/index.ts` | Decision 1: the batch-log insert helper. Decision 8, separately: opt-in `onConflict: 'preserve'` before the existing upsert, writing conflicts over a second connection. Existing callers keep today's `write`. | BJ Ingestion |
| 0, alternative only | `ingestion/lib/src/run/run.test.ts`, `ingestion/lib/src/warehouse/stream.test.ts` | The five input-boundary fixtures, plus the same-batch and cross-run conflict fixtures. | BJ Ingestion |
| 0, alternative only | `orchestration/pipeline/extract.py` (new) and a call from the answer path | The `REPEATABLE READ` copy into an `extract_<id>` schema, and the `DBT_SCHEMA` pairing. It creates schemas; it does not touch `raw`. | BJ Orchestration |
| 0, alternative only | `transformation/models/staging/ops/` (new `_ops__sources.yml`, staging models for batches, extracts, conflicts) | Casts only. `timestamptz` stays `timestamptz`. | BJ Transform |
| 1 | `transformation/dbt_project.yml` | Materialize each new intermediate folder as a view, the same way `transfers` and `tokens` are views. | BJ Transform |
| 1 | `orchestration/pipeline/schedules.py` | Add `ousd_concentration` and `usdc_supply`, each `0 6 * * *`, matching the existing pipelines. `usdt_panel` is added only after decision 5. Jobs stay off until an analyst turns them on, which is how a new schedule already behaves. | BJ Orchestration |
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
| Exclusive cutoff 2026-11-07 00:00 UTC. Pre-deployment days are null | OUSD plan, Accounting. The cutoff is applied in the analysis, per shared rule 11 |
| Tempo: do not add Mint, Burn, and memo amounts on top of Transfer. Credit the ledger holder, including fee movements on a reverted application call, without booking the reverted application transfer or a fee twice | OUSD plan, Accounting. Fee and TIP-20 behaviour is documentation-verified on the pages fetched below, and the deployed bytecode is not |
| USDC window, B0/B1, post-state at B0−1 and B1−1, zero-to-zero rejected, integer base units | USDC plan, Accounting |
| Supply equality is not gross completeness. Checks and aggregates read one build. No manufactured zero days | [Shared input boundary](#shared-input-boundary). USDC plan, Gates |
| Eight static issues in the unexecuted SQL | USDC plan, Gates. The SQL file is not added to the repo |
| CCTP stays inside the totals with no cross-chain match | USDC plan, Non-goals |
| TRON panel blocked until comparable accounting, ordered stages, labels, owner versus address, units, and token-specific supply rules exist | USDT plan. The rules are written as a proposal. The status line stays blocked |
| Share is TRON volume over the three-chain sum. Whole-window share is a ratio of sums. A missing chain makes the share null | USDT plan, Accounting |
| Decimal-normalized token units. No USDC zero-address rule copied onto USDT | USDT plan, Accounting |
| Consolidated gate: one immutable extract, canonical ranges, header times, state-call completeness, finality evidence separate from the cursor, query version, unknown is not a pass | [Shared input boundary](#shared-input-boundary) (one build and a recorded manifest by default; the extract as the alternative), [Day boundaries before a day filter](#day-boundaries-before-a-day-filter), each plan's Gates |

## Changes after the second review

A review of this pull request found these problems. Each is fixed in this revision.

| Problem found | Change |
|---|---|
| The OUSD and USDC marts hard-coded one question's cutoff and a 30-day spine, against layers.md, and were also given a daily schedule | Shared rule 11. Both marts are open-ended daily series. The windows moved to the analyses and `question.yaml`. |
| The versioned extract required every check to read an `extract_` schema while the daily job built from `raw`, so the scheduled build would either fail its own gate or overwrite the answer build | The default boundary is one build from `raw` plus a recorded manifest. The extract is the alternative, and it pairs `RAW_SCHEMA` with `DBT_SCHEMA`. |
| Decision 1 said "no `Source` contract change" while needing the source to hand hashes to `runSource` | Decision 1 now names the optional `StreamSource` field it adds. |
| The header-time equality gate compared a Portal timestamp with the same Portal header | Replaced by independent boundary header reads over RPC and assignment by height. |
| The conflict guard rolled back a batch with no way for the cursor to move again | Operator procedure written. The guard needs a second connection for the conflict row. Alternative only. |
| Four new ops tables and a write-path guard for three questions over finalized, position-keyed logs | The default needs no `ingestion/lib` change. `bj answer` already runs the tests and exits 1. |
| Solana owner lifecycle was specified as the only owner source | The Portal token-balance owner fields and the instruction's authority account are checked first; the walk remains the fixture. |
| USDC collected `Transfer` only, with a separate receipt-sample source | `Mint` and `Burn` are collected from the start, transactions are stored as records, and the receipt source is dropped: an EVM log exists only in a successful transaction. |
| The README scheduled `usdt_panel` while the USDT plan said "only after approval"; `extract.py` was described as read-only; the Tempo record key added a redundant suffix | Each corrected in place. |

## Unresolved decisions for Ian

These stay open. Local decisions in the three plans use the same numbers. Decisions 1 and 8 are a choice of input boundary. Under the default nothing in this batch waits on them.

1. **Input boundary.** Keep the default in [Shared input boundary](#shared-input-boundary), which changes nothing in `ingestion/lib`, or choose the versioned extract. Choosing the extract approves an optional `StreamSource` field, the same-transaction batch log, and the four ops tables. It does not add a decoder and does not change upsert behaviour. The recommendation in this plan is the default.
2. **OUSD first issuance, per chain.** Resolve on chain: deployment or init transaction, earliest successful positive issuance, canonical block or slot and time, and any opening allocation or migration. Product launch is a separate date. Token Terminal's fetched page says launch 24 April 2026. Bridge's fetched announcement is dated 30 September 2026 and says Open USD launched that day. Neither date is a verified first mint.
3. **Base finality.** Portal's finalized head is what EVM stream sources already target. Confirm that this is the cutoff an analyst should publish for Base OUSD, or name a stricter rule and the canonical evidence that proves it. A sequencer head, or the word "finalized" alone, is not that evidence. This plan does not invent an L1 block lag.
4. **Tempo origin.** The Portal dataset list fetched for the planning snapshot has no Tempo dataset. Name the history origin, the access an analyst is allowed to use, and the finality rule for chain id 4217. The same address on chain id 42431 is testnet and is out of the ledger. This review pass did not re-fetch that dataset list.
5. **TRON panel.** The third plan is blocked as specified. Approve or replace the chain set, stages S1–S5, the label confidence threshold, and who may insert a label row (decision 12). Solana owner order is specified under [Solana owner intervals](#solana-owner-intervals); it is not waiting on this decision. Until panel approval, no TRON, Ethereum USDT, or Solana USDT source is in scope to build.
6. **OUSD eligible-denominator list.** The primary series is the full ledger. The sensitivity that drops zero and burn addresses needs an explicit address list per chain, after supply reconciliation shows those balances. Ian confirms the list. It is not "every address that looks dead."
7. **USDT fee leg, confiscation, and zero-address supply, after historical proof.** The fetched `TetherToken.sol` is a 2017 source file, not the October 2026 bytecode. It does not authorize an accounting rule. Both Ethereum logs are stored. Whether S2 sums a fee leg, and whether a transfer to the zero address changes supply, stay null until the catalog proof. TRON paths are proved on TRON, not copied from that file. A null `changes_supply` blocks publication. Absence of proof does not default it to false.
8. **Conflict guard, only with the extract.** Under the default, new sources use today's `write`, for the reasons in [Conflicting payloads](#conflicting-payloads). If decision 1 picks the extract, approve or reject opt-in `onConflict: 'preserve'` and the operator procedure for a stuck batch. Existing sources stay on today's `write` either way.
9. **Optional OUSD token-account mart.** OUSD plan, local item 6. Owner-level HHI stays blocked while any authority owner is unresolved. A token-account mart would be a different unit and would not be compared with EVM address counts.
10. **Archive endpoint.** No archive provider is named. USDC plan, local item 4. Boundary `eth_call`s wait on a named endpoint. `BLOCK_NUMBER=finalized` on the balance source is a different block.
11. **USDC `rule_version` after catalog proof.** USDC plan, local items 2 and 3. Ian accepts the mint and burn paths, including any path that is not a zero-address `Transfer`. The plan does not assume that shape in order to publish.
12. **USDT label authority and confidence threshold.** USDT plan, local item 3. The evidence-date rule and the effective-interval rule are already specified and are stricter together than an effective interval alone: evidence must be dated on or before the movement, and the effective interval must cover it. A label published after the transfer does not apply because someone set `effective_from` earlier. The unpublished threshold means S4 and S5 remove nothing until Ian sets it.

## Dependencies an analyst will hit

- Archive state for historical `totalSupply`, `decimals`, implementation, and `balanceOf` samples. The balance package comment says a past block needs an archive node. No archive endpoint is named in this plan.
- An RPC that answers `eth_getBlockByNumber` for the boundary blocks. eRPC already aliases Ethereum and Base, and a header read needs no archive state.
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
