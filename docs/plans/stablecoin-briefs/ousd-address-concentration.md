# OUSD address concentration

**Pipeline:** `ousd_concentration`  
**Status:** Method accepted conditionally by Quality Gate. This document is a plan. It reports no concentration.  
**Owner of the question:** the analyst, after the phased changes below.  
**Shared rules:** [README.md](./README.md). Where this file and a brief disagree with the Quality Gate review, the review wins.

## Objective

For each native OUSD deployment, give an analyst a daily series from that chain's verified first positive issuance through the exclusive cutoff **2026-11-07 00:00:00 UTC** (2026-11-06 21:00:00 in America/Sao_Paulo, UTC−3):

- total supply
- count of ledger units with a positive eligible balance
- top-10 share and top-50 share
- HHI on the 0–1 scale, over every eligible positive balance

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

**Ethereum and Base.** A new stream package reads every `Transfer` log of the one OUSD address on that chain, with no `wallets` key, from the proven start block through Portal's finalized head, using the same `portalClient` / `finalizedHead` pattern as `evm-erc20-transfers`. A second call source reads `totalSupply`, `decimals`, and the implementation the catalog proves this deployment uses, at the boundary blocks the manifest names. A third call source reads `balanceOf` for a sample of addresses drawn from the reconstructed ledger, at those same blocks. Samples are a check, not the holder set.

**Solana.** A new stream source against Portal dataset `solana-mainnet` (listed on 2026-11-07, unused in this repo). Records are successful token instructions, outer and inner, once each: mint, burn, transfer, plus token-account creation, closure, and `SetAuthority`. The repo's Solana RPC client is the wrong tool: it documents current state only. The decoder lives in the new package unless the manifest exception in the batch README already has Ian's approval to extend `ingestion/lib`.

**Tempo.** No source runs until decision 4 in the batch README names an origin and a finality rule for chain id 4217. The package shape is reserved below so the file list is concrete. The env schema rejects any chain id other than 4217.

**Reconstruction.** dbt rebuilds end-of-day balances from the events plus a verified opening state. The opening state is the proven deployment allocation or the first verified positive supply, not "the first Transfer row that happened to land in the extract." Days before that opening state are null on every concentration column.

**Labels.** Optional seed rows with chain, network, address, role, URL, evidence date, effective from/to, confidence, and version. They never delete a primary-series balance. They only feed the sensitivity mart and the optional founder annotation.

## Unresolved decisions for Ian

1. First issuance per chain, as in the batch README. Implementation of the backfill waits on the catalog proof. The daily mart's shape can be reviewed before that proof; it cannot be loaded.
2. The explicit per-chain list of addresses removed in the sensitivity, after the full ledger ties to supply. Candidates that still need a rule, not a guess: the zero address, any burn address the catalog proves, and Tempo protocol custody that the spec says can hold a balance (FeeManager, ReceivePolicyGuard). A frozen balance stays in supply until the catalog shows it was destroyed.
3. Base finality: Portal finalized head, or a stricter rule Ian names.
4. Tempo origin and finality.
5. The `ingestion/lib` manifest writer (batch README, decision 1).
6. Whether Solana owner-level publication is allowed to ship a second, clearly named token-account mart while some owners are unresolved. The owner-level mart stays blocked until every positive balance has an authority owner. A token-account mart, if Ian wants it, is labeled as a different unit and is not compared with EVM address counts.

## Accounting and collection contracts

### Sources

| Chain | What is collected | Completeness | Filter | Finality |
|---|---|---|---|---|
| Ethereum | Every OUSD `Transfer` log; `totalSupply`, `decimals`, implementation at boundary blocks; `balanceOf` samples | Portal stream from the proven start block through the finalized head, cursor continuity, no gaps in `_sync` | Contract only. A `wallets` key fails the run | Portal finalized head, hash stored |
| Base | Same | Same, on `base-mainnet` | Same | Portal finalized head. Not a sequencer head. See decision 3 |
| Solana | Successful mint, burn, and transfer instructions, including inner instructions, each once; token-account open/close; `SetAuthority` | Portal `solana-mainnet` from the proven start slot through the last finalized slot at run start | Mint only | Finalized slot and its blockhash or equivalent, stored. Missing block time fails that slot's coverage rather than dropping the instruction silently |
| Tempo | TIP-20 `Transfer` as the balance movement, including the net fee `Transfer` on a transaction whose application reverted; `Mint` / `Burn` / `BurnBlocked` / `BurnAt` / `TransferWithMemo` as classification and memo, not as extra amounts | The origin Ian names, full range, chain id 4217 | OUSD address only | The rule Ian names. Testnet 42431 is refused |

Collection does not filter to partners, founders, or exchanges. Failed stream ranges fail the run and leave the previous cursor in place, which is how Pipes already behaves. Failed state calls become dead letters. A parked dead letter fails the coverage manifest.

### Ledger units

- **EVM and Tempo:** holder address, after Tempo's documented virtual-address collapse and after receive-policy credits to the guard. The collapse rule ships only with a proof transaction in the catalog.
- **Solana:** historical token-account authority owner, summed over all of that owner's token accounts for the mint, including accounts that are not the associated token account. This owner is not the Token Program, not a delegate, and not a person. `SetAuthority` moves attribution with no transfer. Closure and recreation stay in the account history. An unresolved owner is reported as its own balance and **blocks** `holder_count`, top-k, and HHI. It is not folded into a single "unknown" holder.

### Full ledger and eligible denominator

For each chain and each UTC day, with `D_full` the sum of reconstructed positive balances that the supply identity uses:

1. Reconcile the **full** positive ledger to `totalSupply` at the closing block (zero-address and burn balances included when they are part of supply). Frozen is not destroyed.
2. Publish primary metrics on that full set. Custodians remain.
3. A sensitivity may remove an explicit address list. It stores the removed balances, sets `D = D_full − removed`, and recomputes count, top-k, and HHI on `D`. The sensitivity does not replace the primary row.

Let `b_i` be eligible positive balances, `D = sum(b_i)`, `N` the count of those balances, `s_i = b_i / D`. Top-k share is the sum of the largest `min(k, N)` balances divided by `D`, for k in {10, 50}. `HHI = sum(s_i²)` over **all** N balances, computed before display rounding, on a 0–1 scale. For `D > 0`, HHI lies in `[1/N, 1]`. For `D = 0`, count, shares, and HHI are null, not zero. Pre-deployment days are null, not zero.

### Supply identity

`totalSupply` at the closing state equals the full reconstructed ledger, in base units, using the decimals read at that block. Tempo fee movements that the spec says do not change `totalSupply` must not be booked as mints. A mint or burn amount is taken from `Transfer` once. `Mint`, `Burn`, and memo events classify that transfer; they are not added again. `burnAt`'s extra `BurnAt` log is not a second burn.

Supply reconciliation does not prove that holder-to-holder transfers are complete, because a missing pair can leave supply unchanged. The balance samples are the additional check: at least one address per chain per checkpoint week, plus the largest primary-series address at each month end, read with `balanceOf` or the Solana equivalent at the closing block. A mismatch fails the day.

### Cutoff

The window end is exclusive. A day's closing state is the last canonical block or slot with timestamp strictly before the next 00:00:00 UTC. The series stops at the last closing state before 2026-11-07 00:00:00 UTC. Events at or after that instant are out of the mart even if the stream has loaded them.

### What the numbers may be called

"Concentration of recorded holder addresses on chain C" or, on Solana, "concentration of recorded token-account authority owners." The answer also prints the block or slot. It does not call the count users, people, or adoption.

## Immutable schemas, grain, and manifests

Raw rows stay the warehouse shape: `id` text, `data` jsonb, `_loaded_at` timestamptz. Amounts are digit strings. EVM `id` is `<block>:<logIndex>`. Solana `id` is `<slot>:<tx>:<instruction index path>` so an inner instruction cannot collide with its outer instruction. Tempo `id` is `<block>:<logIndex>:<event>`.

| Model | Grain | What one row is |
|---|---|---|
| `stg_<chain>__ousd_transfers` | one log or one Solana instruction | Typed columns, no rule. EVM addresses lowercased. Solana addresses unchanged. `block_timestamp` is `timestamptz` |
| `int_ousd_movements` | one balance-changing movement | Signed base-unit delta to a ledger unit. Tempo fee netting and virtual-address collapse happen here, behind a `rule_version` |
| `int_ousd_balances` | chain, ledger unit, closing block | Non-negative base-unit balance. Negative reconstruction fails the build |
| `ousd_supply_checks` | chain, closing block | Opening or checkpoint `totalSupply`, decimals, implementation, sample result, pass/fail |
| `ousd_concentration` | chain, `day_utc` | Primary series. Null before issuance and when coverage is not pass |
| `ousd_concentration_sensitivity` | chain, `day_utc`, `exclusion_set` | Same metrics on the reduced denominator, with removed base units stored |
| `ousd_coverage_manifest` | chain, source run | The `ops.source_manifests` row joined to the dbt invocation that built the day. `coverage_status` is `pass`, `fail`, or `unknown` |

`day_utc` is a `date` produced from `timestamptz` by `(block_timestamp at time zone 'utc')::date`. The calendar spine is a `date` series, not a `timestamp` plus an integer.

`rule_version` is a text constant in the mart. Changing the collapse rule, the exclusion list, or the Solana owner rule increments it and leaves the previous answer folder untouched. Marts are rebuilt tables, so immutability is the manifest: an answer records `manifest_id`, git sha, `rule_version`, and the ingestion `run_id` values. A later rebuild under a new rule is a new answer.

The mart selects days whose manifest `coverage_status` is `pass` and whose manifest filter hash equals the hash stored at extract time. A missing manifest yields no concentration row and fails a test. It does not yield zeros.

## Dependencies

- Shared manifest writer and `ops.source_manifests` (batch README). Blocked on Ian's exception decision.
- Catalog proofs and first-issuance transactions. Blocked on chain reads that this pull request does not perform.
- Portal access for Ethereum, Base, and Solana. Tempo origin, undecided.
- Archive RPC for the state calls. eRPC in this repo already aliases Ethereum and Base. It does not alias Tempo. No new endpoint is added until Ian names one.
- `bj blocks` can map the UTC cutoff to Ethereum and Base blocks. It cannot map Solana slots or Tempo. The Solana and Tempo packages own that mapping and record the method on the manifest.
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
| `transformation/models/staging/ethereum/_ethereum__sources.yml` and `stg_ethereum__ousd_transfers.sql`, `stg_ethereum__ousd_supply.sql`, `stg_ethereum__ousd_balance_samples.sql` | Staging is per source, next to the existing Ethereum staging models. Casts only | BJ Transform |
| `transformation/models/staging/base/_base__sources.yml` and the Base `stg_base__ousd_*.sql` models | Base staging already exists for other sources | BJ Transform |
| `transformation/models/staging/solana/_solana__sources.yml` and `stg_solana__ousd_movements.sql` | Solana staging exists for balances; this adds the history table | BJ Transform |
| `transformation/models/staging/tempo/` (new folder) | No Tempo staging exists | BJ Transform |
| `transformation/models/intermediate/ousd_concentration/` | Joins and rules live under the pipeline folder: movements, balances, owner resolution | BJ Transform |
| `transformation/models/marts/ousd_concentration/ousd_concentration.sql`, `ousd_concentration_sensitivity.sql`, `ousd_supply_checks.sql`, `ousd_coverage_manifest.sql`, `_ousd_concentration__models.yml` | New mart folder. One chain column, not four marts | BJ Transform |
| `transformation/seeds/ousd_label_ledger.csv` and a block in `transformation/seeds/_seeds.yml` | Dated optional labels. Ships with the column contract and no unlabeled rows presented as founders. Does not reuse `cex_addresses` | BJ Transform |
| `transformation/dbt_project.yml` | View materialization for the new intermediate folder. Listed in the batch README because the file is shared | BJ Transform |

### Phase D — schedule and analyst surface

| Path | Why this path | Owner |
|---|---|---|
| `orchestration/pipeline/schedules.py` | One new key `ousd_concentration`. Shared file, one owner, listed in the batch README | BJ Orchestration |
| `orchestration/tests/test_definitions.py` | Parent-key assertion for the new mart, same style as `test_erc20_transfers_reads_each_chain_through_its_own_model` | BJ Orchestration |
| `.claude/skills/blockjuice/references/question-spec.md` | Exclusive UTC end and non-EVM heights. Shared edit | BJ Skills & Reports |
| `transformation/analyses/ousd_address_concentration.sql` | The question's filter over the mart: four chains, primary series, cutoff | BJ Skills & Reports |
| `answers/ousd-address-concentration/question.yaml` (gitignored, written when the pipeline runs) | Definitions an analyst ships with the number | BJ Skills & Reports |

## Validation, coverage, and finality gates

All of these are `error` severity. `unknown` fails. A green Dagster run is not a pass.

1. Manifest present for every chain in the answer, with filter hash, cursor number, cursor hash, finality text, and the same `dagster_run_id` as the dbt invocation.
2. Loaded range covers the proven start through the last block or slot before the cutoff. Ethereum and Base: Portal finalized. Solana: finalized. Tempo: the approved rule. Base is not accepted on a sequencer-head label.
3. Unique ids. Two payloads with one id fail. The warehouse upsert that keeps the last row (`ingestion/lib/src/warehouse/index.ts`) is not the conflict check; the source test rejects the conflict first.
4. Amounts are non-null digit strings. Staging `numeric` equals its truncation. No negative balances.
5. Full-ledger supply identity at each checkpoint, in base units, using the decimals from the supply source at that block.
6. Balance samples match the reconstruction at the same block. Supply equality alone does not pass this gate.
7. Null timestamps, null chain, and null token fail in staging, before the day filter. The day filter is not the place that discovers missing fields.
8. `D = 0` and pre-issuance days stay null. A test counts those days and fails if a share is 0.
9. HHI is null when owner resolution is incomplete on Solana. A test fails if a Solana HHI exists while any positive balance is unresolved.
10. Tempo: a fixture with a reverted application call keeps the net fee movement and drops the reverted application transfer. A fixture with `burnAt` counts one supply decrease. A fixture with a memo event does not double the amount.
11. Chain id 4217 on every Tempo row. A 42431 row fails.
12. Cutoff exclusive: a row timestamped at or after 2026-11-07 00:00:00 UTC is absent from the mart.

## Tests

- Package tests beside each source, same runner as `evm-erc20-transfers/src/source.test.ts`: no `wallets` key, contract filter, id shape, bigint amount preserved as a string, Tempo chain id.
- dbt unit tests on `int_ousd_movements` for: EVM mint from the zero address once the catalog proves that is this token's mint; Solana `SetAuthority` with no transfer; Tempo virtual-address collapse; Tempo fee on a reverted application; `burnAt` single count. Each fixture is a catalog proof row, not a made-up topic.
- Singular tests in `transformation/tests/` for supply identity, sample match, HHI bounds when `D > 0`, null HHI when `D = 0`, and the Solana unresolved-owner block.
- `not_null` and `unique` on the mart grain `(chain, day_utc)` and on the sensitivity grain.
- `accepted_values` on `chain`: `ethereum`, `base`, `solana`, `tempo`.
- Orchestration parent-key test listed above.
- `bj answer` coverage check once `question.yaml` names the history sources. That check is necessary and, by itself, does not satisfy gates 1–6.

## Analyst UX

The answer folder is `answers/ousd-address-concentration/`. `question.yaml` definitions say:

- holder, on EVM and Tempo: one address in the reconstructed ledger
- holder, on Solana: one historical token-account authority owner
- day: a UTC date, closed at the last canonical block or slot before the next midnight
- primary series: full ledger, custodians included
- HHI: 0–1, all eligible positive balances

The headline analysis returns one row per chain per day with supply, holder count, top-10 share, top-50 share, and HHI, plus `rule_version` and `manifest_id`. A second analysis returns the sensitivity. Charts, built only after the gates pass, are supply beside primary HHI, and a small table of top-10 versus top-50. Solana is not plotted on the same axis as EVM address counts without the unit in the series name. `bj report` carries those definitions into the xlsx, pdf, and Google Doc. Display rounding happens after HHI is stored.

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
