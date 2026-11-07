# OUSD address concentration

**Pipeline:** `ousd_concentration`  
**Status:** Method accepted conditionally by Quality Gate. This document is a plan. It reports no concentration.  
**Owner of the question:** the analyst, after the phased changes below.  
**Shared rules:** [README.md](./README.md). Where this file and a brief disagree with the Quality Gate review, the review wins.

## Objective

For each native OUSD deployment, give an analyst a daily series from that chain's verified first positive issuance onward:

- total supply
- count of ledger units with a positive eligible balance
- top-10 share and top-50 share
- HHI on the 0–1 scale, over every eligible positive balance

The question's window ends at the exclusive cutoff **2026-11-07 00:00:00 UTC** (2026-11-06 21:00:00 in America/Sao_Paulo, UTC−3). Per shared rule 11 in the batch README, the mart is open-ended and that cutoff lives in `transformation/analyses/ousd_address_concentration.sql` and in `question.yaml`, not in the mart. A later question reads the same mart with a later cutoff.

The primary series includes custodians, issuer balances, bridges, and protocol custody. A labeled exclusion is a separate sensitivity and recomputes its own denominator. Chains stay separate. No cross-chain identity is invented.

## Non-goals

- No "adoption," no unique people, no beneficial owners, no founder-participation result. Founder labels are an optional annotation with a public URL. An unlabeled address is unlabeled.
- No launch-aligned growth chart that starts on 24 April 2026 or 30 September 2026. Those are conflicting source dates.
- No reuse of `analytics.latest_balances`, `analytics.erc20_transfers`, or `analytics.classified_transfers` as the OUSD ledger.
- No wallet filter. The three Ethereum wallets in `evm-erc20-transfers` stay on that source and are not an OUSD holder set.
- No claim about redemption durability or about why supply changed.

## Verified facts

Documentation-verified on 2026-11-07, from the pages named in the batch README. Not verified on chain: bytecode, admin keys, decimals on Ethereum, Base, and Solana, and every historical upgrade.

| Item | What was read |
|---|---|
| Product | Bridge's overview calls it Open USD (OUSD), launched by Open Standard and issued by Bridge. The 30 September 2026 announcement says it is currently issued by **Bridge Building Inc.** Bridge National Trust Bank is described there as in organization, not operational, and not the issuer. |
| Partners named on those pages | Coinbase, Mastercard, Shopify, Stripe, Visa. A corporate name on a page is not a blockchain address. |
| Ethereum | `0x9f6F3991D525015a6F8CaF062C83b62fD3AC4436` in Bridge's address table. |
| Base | `0xB2000000000000000000002fEb517dFeC7415344` |
| Solana mint | `ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB` (case-sensitive) |
| Tempo | Bridge table `0x20c0000000000000000000006a37DA5C996874BE`. Tempo's guide prints the same hex in lowercase and says mainnet chain id **4217**, TIP-20, `decimals()` 6, symbol `OUSD`. The same address on Tempo testnet chain id **42431** is a different token. This plan pins chain id 4217. Checksum validity was not recomputed. |
| Not this token | Origin Dollar. Nothing in the repo identifies either token. The addresses above are the only OUSD identities these models may load. |
| Tempo events, from the TIP-20 spec | `Transfer` is documented as emitted for movements including mints and burns (`from` or `to` the zero address). Separate `Mint`, `Burn`, `BurnBlocked`, `BurnAt`, and `TransferWithMemo` events exist. `burnAt` is documented to emit both `Transfer(from, address(0))` and `BurnAt`. Memo events carry the same movement plus a 32-byte memo. |
| Tempo holders, from that spec | A registered virtual address is a forwarding alias. An allowed deposit is documented as two standard `Transfer` hops that should be collapsed to the master wallet. A receive-policy rejection credits ReceivePolicyGuard `0xb10c000000000000000000000000000000000000` and does not credit the addressed recipient. |
| Tempo fees, from the fee spec | An included transaction whose application call reverts still pays fees. The post-execution step logs a `Transfer` for the net fee. `transferFeePreTx` and `transferFeePostTx` are documented not to change `totalSupply()`. Fee pre-collection and the later refund are one net fee, not two holder movements. |
| Conflicting public dates | Token Terminal's fetched page says launch 24 April 2026 and public issuance since April. Bridge's announcement is dated 30 September 2026 and says Open USD launched that day on Base, Ethereum, Solana, and Tempo. |

Repo facts that bind the design are in the batch README. In particular, OUSD is on none of the checked-in address lists, Solana sources cannot read a past slot, and Portal's fetched dataset list has `solana-mainnet` and no Tempo dataset.

## Proposed design

Four chain ledgers, one mart, one daily grain per chain.

**Catalog first.** `catalog/protocols/ousd/` is written when implementation starts, under the explore-protocol workflow, with a proof log per event and a deploy transaction per chain. This pull request does not create that folder. `START_BLOCK` and the Solana start slot stay unset until those proofs exist. A source whose start is still a placeholder fails its own env check rather than streaming from zero.

**Ethereum and Base.** A new stream package reads every `Transfer` log of the one OUSD address on that chain, with no `wallets` key, from the proven start block. Each run targets Portal's finalized head the way `evm-erc20-transfers` does, and may stop earlier under `maxBlocksPerRun`. The published range is what the cursor covers in the build `bj answer` records ([batch README](./README.md#shared-input-boundary)), and the cursor has to be at or past the last block before the question's cutoff. A second call source reads `totalSupply`, `decimals`, and the implementation the catalog proves this deployment uses, at each day's closing block. A third call source reads `balanceOf` for a sample of addresses drawn from the reconstructed ledger, at those same blocks. Samples are a check, not the holder set. The shared `evm-block-headers` source reads the boundary blocks over RPC for the [day-boundary rule](./README.md#day-boundaries-before-a-day-filter). Expected call ids are part of the answer's completeness check. An empty dead-letter table with a missing id fails the answer.

**Solana.** A new stream source against Portal dataset `solana-mainnet` (listed on 2026-11-07, unused in this repo). Records are successful token instructions, outer and inner, once each: mint, burn, transfer, plus token-account creation, closure, and `SetAuthority`, and the per-transaction token balance records with their owner fields if the dataset serves them. The repo's Solana RPC client is the wrong tool: it documents current state only. The decoder stays in this package. Decision 1 in the batch README does not authorize a Solana decoder in `ingestion/lib`. Owner intervals follow [Solana owner intervals](./README.md#solana-owner-intervals), not a join on slot, and the implementation first checks whether the dataset's owner fields make the lifecycle walk a cross-check.

**Tempo.** No source runs until decision 4 in the batch README names an origin and a finality rule for chain id 4217. The package shape is reserved below so the file list is concrete. The env schema rejects any chain id other than 4217.

**Reconstruction.** dbt rebuilds end-of-day balances from the events plus a verified opening state. The opening state is the proven deployment allocation or the first verified positive supply, not "the first Transfer row that happened to load." Days before that opening state are null on every concentration column.

**Labels.** Optional seed rows with chain, network, address, role, URL, evidence date, effective from/to, confidence, and version. They never delete a primary-series balance. They only feed the sensitivity mart and the optional founder annotation.

## Unresolved decisions for Ian

1. First issuance per chain. Batch README decision 2. Implementation of the backfill waits on the catalog proof. The daily mart's shape can be reviewed before that proof; it cannot be loaded.
2. The explicit per-chain list of addresses removed in the sensitivity, after the full ledger ties to supply. Batch README decision 6. Candidates that still need a rule, not a guess: the zero address, any burn address the catalog proves, and Tempo protocol custody that the spec says can hold a balance (FeeManager, ReceivePolicyGuard). A frozen balance stays in supply until the catalog shows it was destroyed.
3. Base finality. Batch README decision 3.
4. Tempo origin and finality. Batch README decision 4.
5. The input boundary. Batch README decision 1, and decision 8 only if the extract is chosen. Under the default boundary nothing in this plan waits on them, and no `ingestion/lib` change is needed.
6. Whether Solana owner-level publication is allowed to ship a second, clearly named token-account mart while some owners are unresolved. Batch README decision 9. The owner-level mart stays blocked until every positive balance has an authority owner under the ordered lifetime rule. A token-account mart, if Ian wants it, is labeled as a different unit and is not compared with EVM address counts.

## Accounting and collection contracts

### Sources

| Chain | What is collected | Completeness | Filter | Finality |
|---|---|---|---|---|
| Ethereum | Every OUSD `Transfer` log; `totalSupply`, `decimals`, implementation at each day's closing block; `balanceOf` samples; boundary headers over RPC | Cursor from the proven start through at least the last block before the question's cutoff, in the build the answer records. A single run may stop short of the head under the block cap. Expected state calls are complete even when dead letters are empty | Contract only. A `wallets` key fails the run | Cursor number and hash from `_sync`, with Portal's finalized head at answer time at or past the cursor. Day boundaries proved per the batch README before any day is assigned |
| Base | Same | Same, on `base-mainnet` | Same | Same cursor pair and head. Not a sequencer head. Batch README decision 3 |
| Solana | Successful mint, burn, and transfer instructions, including inner instructions, each once; token-account open/close; `SetAuthority`, ordered by the lifetime key; token balance owner fields if served | Portal `solana-mainnet` from the proven start slot through the last finalized slot the cursor covers | Mint only | Finalized slot. A null block time is unassigned and fails every scope it can affect, per the batch README day-boundary rule. It does not fail only one guessed day |
| Tempo | TIP-20 `Transfer` as the balance movement, including the net fee `Transfer` on a transaction whose application reverted; `Mint` / `Burn` / `BurnBlocked` / `BurnAt` / `TransferWithMemo` as classification and memo, not as extra amounts | The origin Ian names, full range, chain id 4217 | OUSD address only | The rule Ian names. Testnet 42431 is refused |

Collection does not filter to partners, founders, or exchanges. A stream error rolls back the batch in flight. Batches that already committed stay, with their `run_id`, and the cursor stays at the last of those batches. The next run resumes from there. Failed state calls become dead letters. A parked dead letter fails the answer. An expected state call that was never attempted also fails it, even when the dead-letter count is zero.

### Ledger units

- **EVM and Tempo:** holder address, after Tempo's documented virtual-address collapse and after receive-policy credits to the guard. The collapse rule ships only with a proof transaction in the catalog.
- **Solana:** historical token-account authority owner effective at that instruction, using the order and account lifetime in the batch README. Summed over all of that owner's token accounts for the mint, including accounts that are not the associated token account. This owner is not the Token Program, not a delegate, and not a person. `SetAuthority` moves attribution for later instructions only, with no transfer amount. A close ends the lifetime. Recreation starts a new one and does not keep the old owner. An unresolved owner is reported as its own balance and **blocks** `holder_count`, top-k, and HHI. It is not folded into a single "unknown" holder. A slot-level join is not this rule.

### Full ledger and eligible denominator

For each chain and each UTC day, with `D_full` the sum of reconstructed positive balances that the supply identity uses:

1. Reconcile the **full** positive ledger to `totalSupply` at the closing block (zero-address and burn balances included when they are part of supply). Frozen is not destroyed.
2. Publish primary metrics on that full set. Custodians remain.
3. A sensitivity may remove an explicit address list. It stores the removed balances, sets `D = D_full − removed`, and recomputes count, top-k, and HHI on `D`. The sensitivity does not replace the primary row.

Let `b_i` be eligible positive balances, `D = sum(b_i)`, `N` the count of those balances, `s_i = b_i / D`. Top-k share is the sum of the largest `min(k, N)` balances divided by `D`, for k in {10, 50}. `HHI = sum(s_i²)` over **all** N balances, computed before display rounding, on a 0–1 scale. For `D > 0`, HHI lies in `[1/N, 1]`. For `D = 0`, count, shares, and HHI are null, not zero. Pre-deployment days are null, not zero.

### Supply identity

`totalSupply` at the closing state equals the full reconstructed ledger, in base units, using the decimals read at that block. Tempo fee movements that the spec says do not change `totalSupply` must not be booked as mints. A mint or burn amount is taken from `Transfer` once. `Mint`, `Burn`, and memo events classify that transfer; they are not added again. `burnAt`'s extra `BurnAt` log is not a second burn.

Supply reconciliation does not prove that holder-to-holder transfers are complete, because a missing pair can leave supply unchanged. The balance samples are the additional check: at least one address per chain per checkpoint week, plus the largest primary-series address at each month end, read with `balanceOf` or the Solana equivalent at the closing block. A mismatch fails the day.

### Days and the cutoff

A day's closing state is the last canonical block or slot before the next midnight's proved boundary block, per the [day-boundary rule](./README.md#day-boundaries-before-a-day-filter). The mart holds every day from the proven first issuance through the last day whose closing block the cursor covers and whose boundaries are proved. A day the cursor has not reached is absent from the status spine, not `fail`.

The question's window end is exclusive. The analysis selects `day_utc < '2026-11-07'`, with the date passed from `question.yaml`'s `window`, so the answer stops at the last closing state before 2026-11-07 00:00:00 UTC. The mart may already hold later days. They are the next question's days, not this one's.

### What the numbers may be called

"Concentration of recorded holder addresses on chain C" or, on Solana, "concentration of recorded token-account authority owners." The answer also prints the block or slot. It does not call the count users, people, or adoption.

## Immutable schemas, grain, and manifests

Raw rows stay the warehouse shape: `id` text, `data` jsonb, `_loaded_at` timestamptz. Amounts are digit strings matching `^[0-9]+$` before any cast. EVM `id` is `<block>:<logIndex>`. Solana `id` is `<slot>:<transaction_index>:<tx>:<outer>:<inner_path>` so an inner instruction cannot collide with its outer instruction, and order fields are not optional. Tempo `id` is `<block>:<logIndex>`, the same key as every other EVM log; the event name is a field of `data`. A key is a place in the chain, so a rerun of a finalized range is idempotent. If Ian chooses the extract, the decision 8 guard runs before the upsert as well.

| Model | Grain | What one row is |
|---|---|---|
| `stg_<chain>__ousd_transfers` | one log or one Solana instruction | Typed columns, no rule. EVM addresses lowercased. Solana addresses unchanged. `block_timestamp` is `timestamptz` and is informational; the day comes from block number and the proved boundaries |
| `stg_<chain>__block_headers` | one boundary block | Number, hash, timestamp from RPC. Casts only |
| `int_ethereum_ousd_movements`, `int_base_ousd_movements` | one balance-changing log on that chain | Signed base-unit delta. EVM rules only |
| `int_solana_ousd_movements` | one instruction | Owner from the ordered lifetime. No Tempo rule in this file |
| `int_tempo_ousd_movements` | one balance-changing log | Fee netting and virtual-address collapse, behind a `rule_version`. No Solana rule in this file |
| `int_ousd_balances` | chain, ledger unit, closing block | Union of the chain movement models, then the running balance. Non-negative. Negative reconstruction fails the build |
| `ousd_supply_checks` | chain, closing block | Opening or checkpoint `totalSupply`, decimals, implementation, sample result, pass/fail, built in the same invocation as the mart |
| `ousd_concentration_status` | chain, `day_utc` | One row per day from the proven first issuance through the last covered day. `pass`, `fail`, or `unknown`. Measures null unless `pass`. Pre-issuance and `D = 0` stay null here too |
| `ousd_concentration` | chain, `day_utc` | Published primary series. **Pass rows only.** A failed day is a missing row, not a null-measure row |
| `ousd_concentration_sensitivity` | chain, `day_utc`, `exclusion_set` | Same metrics on the reduced denominator, pass rows only, with removed base units stored |

`day_utc` is a `date` assigned by block number between proved boundary blocks, never by casting a row's own timestamp. The calendar spine on the status model is a `date` series. The published mart does not contain the spine's failed days.

`rule_version` and `built_by_invocation` (dbt's `invocation_id`) are columns on every published row. Marts are rebuilt tables, so what makes an answer reproducible is its manifest: `bj answer` records the git sha, `rule_version`, the invocation, and per chain the cursor number and hash and Portal's finalized head at that time. Run ids are context in `ops.ingestion_runs`. They are not the freeze. A later rebuild under a new rule is a new `rule_version` and a new answer.

## Dependencies

- The answer manifest in the batch README (decision 1, default). No `ingestion/lib` change. If Ian chooses the extract instead, decisions 1 and 8 apply and neither adds a Solana or Tempo decoder.
- The shared `evm-block-headers` call source for the boundary blocks, listed in the batch README.
- Catalog proofs and first-issuance transactions. Blocked on chain reads that this pull request does not perform.
- Portal access for Ethereum, Base, and Solana. Tempo origin, undecided.
- Archive RPC for the state calls. eRPC in this repo already aliases Ethereum and Base. It does not alias Tempo. No new endpoint is added until Ian names one.
- `bj blocks` can map each UTC midnight to Ethereum and Base blocks. It cannot map Solana slots or Tempo. The Solana and Tempo packages own that mapping and record the method in the catalog NOTES.
- Optional labels. `seeds/cex_addresses` is the UNI October 2026 seed and is not an input.

## Phased changes

Each row is one owner's change. Paths are the files to add or edit when implementation is allowed. None of them are edited in this pull request.

### Phase A — proofs, before any backfill

| Path | Why this path | Owner |
|---|---|---|
| `catalog/protocols/ousd/protocol.yaml` | explore-protocol entry point. Deploy tx, chain id, event signatures. Empty stubs are not allowed; the workflow requires proof | BJ Ingestion |
| `catalog/protocols/ousd/NOTES.md` | Field meanings, Tempo double-count rules, virtual-address and fee rules, proof table | BJ Ingestion |
| `catalog/protocols/ousd/abis/*.json` | Event ABIs the stream decodes | BJ Ingestion |

### Phase B — extract

| Path | Why this path | Owner |
|---|---|---|
| `ingestion/sources/evm-ousd-transfers/` (`src/source.ts`, `src/source.test.ts`, `package.json`, `chains/ethereum/`, `chains/base/`) | New stream so `evm-erc20-transfers` keeps its wallet filter and cursor. `forChain` already names `raw.<chain>_ousd_transfers`. `addresses.json` holds the one token and must not contain `wallets`. `START_BLOCK` is the catalog deploy block | BJ Ingestion |
| `ingestion/sources/evm-ousd-supply/` | Call source. `evm-erc20-metadata` reads name, symbol, and decimals at `BLOCK_NUMBER=latest` and has no `totalSupply` or implementation. A new table is required | BJ Ingestion |
| `ingestion/sources/evm-ousd-balance-samples/` | Call source for the independent `balanceOf` samples. The balance package only reads wallets listed in its `addresses.json` | BJ Ingestion |
| `ingestion/sources/solana-ousd-movements/` | First Solana history package. `solana-spl-balances` is current finalized state for three wallets | BJ Ingestion |
| `ingestion/sources/tempo-ousd-ledger/` | Reserved package. Env rejects chain id other than 4217. Not run until the Tempo origin decision | BJ Ingestion |
| `ingestion/sources.json` | Regenerated by `pnpm generate-sources` after the packages exist. Hand edits fail `test_sources_json_is_fresh` | BJ Ingestion |

### Phase C — transform

| Path | Why this path | Owner |
|---|---|---|
| `transformation/models/staging/ethereum/_ethereum__sources.yml` and `stg_ethereum__ousd_transfers.sql`, `stg_ethereum__ousd_supply.sql`, `stg_ethereum__ousd_balance_samples.sql`, `stg_ethereum__block_headers.sql` | Staging is per source, next to the existing Ethereum staging models. Casts only. The header model is shared with the USDC pipeline and is written once | BJ Transform |
| `transformation/models/staging/base/_base__sources.yml` and the Base `stg_base__ousd_*.sql` and `stg_base__block_headers.sql` models | Base staging already exists for other sources | BJ Transform |
| `transformation/models/staging/solana/_solana__sources.yml` and `stg_solana__ousd_movements.sql` | Solana staging exists for balances; this adds the history table | BJ Transform |
| `transformation/models/staging/tempo/` (new folder) | No Tempo staging exists | BJ Transform |
| `transformation/models/intermediate/ousd_concentration/int_<chain>_ousd_movements.sql` and `int_ousd_balances.sql` | One movement model per chain, then a balance model that unions them. Solana owner order is only in the Solana file | BJ Transform |
| `transformation/models/marts/ousd_concentration/ousd_concentration.sql`, `ousd_concentration_status.sql`, `ousd_concentration_sensitivity.sql`, `ousd_supply_checks.sql`, `_ousd_concentration__models.yml` | Published mart is pass rows only. Status model holds `pass` / `fail` / `unknown` and unassigned amounts | BJ Transform |
| `transformation/seeds/ousd_label_ledger.csv` and a block in `transformation/seeds/_seeds.yml` | Dated optional labels. Ships with the column contract and no unlabeled rows presented as founders. Does not reuse `cex_addresses` | BJ Transform |
| `transformation/dbt_project.yml` | View materialization for the new intermediate folder. Listed in the batch README because the file is shared | BJ Transform |

### Phase D — schedule and analyst surface

| Path | Why this path | Owner |
|---|---|---|
| `orchestration/pipeline/schedules.py` | One new key `ousd_concentration`. Shared file, one owner, listed in the batch README | BJ Orchestration |
| `orchestration/tests/test_definitions.py` | Parent-key assertion for the new mart, same style as `test_erc20_transfers_reads_each_chain_through_its_own_model` | BJ Orchestration |
| `.claude/skills/blockjuice/references/question-spec.md` | Exclusive UTC end and non-EVM heights. Shared edit | BJ Skills & Reports |
| `transformation/analyses/ousd_address_concentration.sql` | The question's filter over the mart: four chains, primary series, `day_utc` before the cutoff taken from `question.yaml`'s window. This is the only place the cutoff appears | BJ Skills & Reports |
| `answers/ousd-address-concentration/question.yaml` (gitignored, written when the pipeline runs) | Definitions an analyst ships with the number | BJ Skills & Reports |

## Validation, coverage, and finality gates

All of these are `error` severity. `unknown` fails closed. A green Dagster run is not a pass. These gates are specified. They are not implemented in this pull request.

1. One dbt invocation builds the mart and runs every gate below, and `bj answer` records that invocation with, per chain, `cursor_number`, `cursor_hash`, Portal's finalized head at answer time, the filter, and the expected call ids. A shared `dagster_run_id` is not this gate. If Ian chooses the extract, the five input-boundary fixtures in the batch README apply here too.
2. The cursor covers the proven start through the last block or slot before the question's cutoff. A capped run may have stopped short of the head. Ethereum and Base: Portal finalized target, and the cursor at or below Portal's finalized head at answer time. Solana: finalized slots. Tempo: the rule in decision 4. Base is not accepted on a sequencer-head label.
3. Records are keyed by chain position and a rerun of a finalized range is idempotent, which the package test shows by writing the same batch twice. If Ian chooses the extract, decision 8's guard applies in the write path before upsert.
4. Amount text matches `^[0-9]+$` before a cast. No negative balances. Network, canonical hash, transaction id, and log or instruction position are non-null before the day filter.
5. Full-ledger supply identity at each checkpoint, in base units, using the decimals from the supply source at that block. A missing expected supply call fails even when dead letters are empty.
6. Balance samples match the reconstruction at the same block, in the same build. Supply equality alone does not pass this gate.
7. Day boundaries proved before any day is assigned: Portal and RPC agree on the boundary blocks' hash and timestamp, and events take their day from block number between those boundaries. A null Solana block time is unassigned and fails every scope it can affect, not one guessed day.
8. `D = 0` and pre-issuance days are null on the status model and absent from the published mart. A test fails if a share is 0 there.
9. HHI is absent from the published mart when owner resolution is incomplete on Solana. The three ordered-lifetime fixtures in the batch README are required.
10. Tempo: a fixture with a reverted application call keeps the net fee movement and drops the reverted application transfer. A fixture with `burnAt` counts one supply decrease. A fixture with a memo event does not double the amount.
11. Chain id 4217 on every Tempo row. A 42431 row fails.
12. Cutoff exclusive, in the analysis: no row with `day_utc` on or after the cutoff date reaches the answer. The mart may hold later days; the analysis test checks the answer's rows, not the mart's.

## Tests

- Package tests beside each source, same runner as `evm-erc20-transfers/src/source.test.ts`: no `wallets` key, contract filter, id shape, bigint amount preserved as a string, Tempo chain id, the same batch written twice leaving one row, null transaction id and null instruction index rejected. If Ian chooses the extract, add the same-batch and cross-run conflict fixtures that call the preserve-guard.
- dbt unit tests on the per-chain movement models: EVM mint from the zero address once the catalog proves that is this token's mint; the three Solana lifetime fixtures (transfer then `SetAuthority` then transfer in one transaction; two transactions in one slot; close then recreate); Tempo virtual-address collapse; Tempo fee on a reverted application; `burnAt` single count. Catalog proof rows are used when they exist. Until then the Solana fixtures are labeled specification fixtures, not chain observations.
- Singular tests in `transformation/tests/` for supply identity, sample match, boundary disagreement between Portal and RPC, an event binned by height rather than by its own timestamp, unassigned Solana time blocking the window, HHI bounds when `D > 0`, and the Solana unresolved-owner block. The supply and sample tests read `var('coverage')`, which `bj answer` passes, the way `erc20_transfers_match_balances.sql` already does.
- `not_null` and `unique` on the published mart grain `(chain, day_utc)` and on the sensitivity grain. `accepted_values` of `coverage_status` on the status model: `pass`, `fail`, `unknown`. The published mart's status column accepts only `pass`.
- `accepted_values` on `chain`: `ethereum`, `base`, `solana`, `tempo`.
- Orchestration parent-key test listed above. The published mart's parents include each chain movement model, the supply checks, and the boundary header staging models.
- `bj answer` coverage check once `question.yaml` names the history sources. That check is necessary and, by itself, does not satisfy gates 1–7.

## Analyst UX

The answer folder is `answers/ousd-address-concentration/`. `question.yaml` definitions say:

- holder, on EVM and Tempo: one address in the reconstructed ledger
- holder, on Solana: one historical token-account authority owner, at that instruction's place in the ordered lifetime
- day: a UTC date, closed at the last canonical block or slot before the next midnight's proved boundary block
- window: days before 2026-11-07, applied by the analysis
- primary series: full ledger, custodians included
- HHI: 0–1, all eligible positive balances

The headline analysis reads `ousd_concentration` only, so a failed day is absent. A companion analysis reads `ousd_concentration_status` and shows `fail` and `unknown` with null measures. Columns include supply, holder count, top-10 share, top-50 share, HHI, `rule_version`, and `built_by_invocation`. Charts are specified only after the gates pass: supply beside primary HHI, and a small table of top-10 versus top-50. Solana is not plotted on the same axis as EVM address counts without the unit in the series name. `bj report` carries those definitions into the xlsx, pdf, and Google Doc. Display rounding happens after HHI is stored. Nothing in this pull request builds the chart.

Founder annotations appear only on rows whose label seed has a URL, an evidence date, and an effective interval covering that day. Missing labels are an "unlabeled" balance, never a "non-founder" balance.

## Risks

- Ethereum and Base OUSD history may be large. The skill requires a Portal count on a short sample before a backfill, shown to the analyst. This plan does not contain that estimate.
- A wrong Tempo collapse or a dropped reverted-transaction fee moves holder balances while supply still reconciles. The sample gate is what catches that, so a small sample is a real risk. The weekly-plus-largest-holder sample is the minimum, not a proof of every balance.
- Solana owner history is the longest new decoder. Shipping EVM first is fine only if the answer refuses an "all native deployments" sentence until Tempo and Solana manifests pass.
- Sharing the existing Ethereum transfer cursor would permanently mix a wallet filter into OUSD. The new package is the mitigation.

## Explicit out of scope

- Origin Dollar and any other OUSD ticker.
- Cross-chain merged holders.
- Partner or founder concentration as a primary metric.
- Price, market cap, reserve composition, and the GENIUS Act commentary on the issuer pages.
- Editing the wallet-filtered Ethereum transfer source, the UNI-only Base transfer source, or A–H.
- Running Tempo against chain id 42431.
- Treating 24 April or 30 September 2026 as the first block.
