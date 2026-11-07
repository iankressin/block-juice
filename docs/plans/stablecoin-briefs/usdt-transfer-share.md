# USDT transfer-volume share inside a three-chain panel

**Pipeline:** `usdt_panel`  
**Status: blocked as specified.** Quality Gate blocked the pre-review specification. This file writes the missing definitions so a later review can accept or reject them. Ian has not approved the panel, the stages, or the exclusions. No source in this pipeline is authorized to build until that approval and a Quality Gate review of this pull request.

The result an analyst may eventually title, if the gates pass, is: **TRON's share of USDT transfer volume within this three-chain panel under rule set S.** That sentence is not a measurement. This plan has no volumes.

Shared rules live in [README.md](./README.md).

## Objective

Measure how TRON's share of USDT movement changes when the same rules are applied to native USDT on TRON, Ethereum, and Solana, over the same 30 UTC days as the Ethereum USDC window:

`[2026-10-08 00:00:00Z, 2026-11-07 00:00:00Z)`.

The endpoint is excluded. Bins are UTC dates. The panel is these three chains and this token only.

## Non-goals

- Not all stablecoins, not all chains, and not a test of any external 73% figure. A selected sensitivity is not a confidence interval and is not a "market share range."
- No wash trading, no retail payments, no independent users, no economic settlement. Removing a labeled transfer does not make that transfer fraudulent or meaningless.
- No USDC zero-address mint rule copied onto USDT.
- No dollar volume. Amounts are USDT token units. A price would require a declared price source, and none is declared.
- No claim about Tether on other protocols listed on Tether's directory (Avalanche, Liquid, TON, and the rest).

## Verified facts

| Item | Evidence | Limit |
|---|---|---|
| TRON USDT `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | Tether supported-protocols page, fetched 2026-11-07, TRC-20 section | Not a decimals, bytecode, or deprecation check. Do not lowercase this Base58 string |
| Ethereum USDT `0xdac17f958d2ee523a2206206994597c13d831ec7` | Same page, Ethereum USD₮ link | Same limit |
| Solana USDT `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | Same page, Solana section | Case-sensitive. The mint is already listed in `ingestion/sources/solana-spl-balances/addresses.json` for three wallets at the latest finalized slot. That is not transfer history |
| Ethereum contract file on GitHub's default branch | `https://raw.githubusercontent.com/tethercoin/USDT/main/TetherToken.sol`, fetched 2026-11-07. Header says submitted to Etherscan on 2017-11-28 | **Not** proof of the bytecode at the Ethereum address during this window |
| What that file contains | `issue` increases the owner balance and `_totalSupply` and emits `Issue(amount)`. `redeem` decreases both and emits `Redeem(amount)`. Neither function in this file emits a zero-address `Transfer`. `destroyBlackFunds` zeros a blacklisted balance, decreases `_totalSupply`, and emits `DestroyedBlackFunds`. `transfer` / `transferFrom` can emit a second `Transfer` to `owner` when `basisPointsRate` produces a fee, then a `Transfer` of the send amount. `deprecate` points reads and writes at an upgraded address. The constructor assigns the initial supply to `owner` with no `Issue` event in the file | Live fee rate, blacklist use, and whether this file matches October 2026 are unverified |
| Portal datasets | Fetched list includes `tron-mainnet`, `ethereum-mainnet`, `solana-mainnet` | This repo's stream code only constructs an EVM Portal client. `bj blocks` has no TRON or Solana entry |
| Repo has no TRON package | `ingestion/sources.json`, `ingestion/lib/src/` (evm, solana, bitcoin) | A TRON decoder does not exist to extend |
| Solana RPC client | `ingestion/lib/src/solana/client.ts` states reads take a commitment, not a slot | Cannot backfill the window |
| EVM staging lowercases addresses | `stg_ethereum__erc20_transfers.sql` | A TRON or Solana model that copies `lower()` corrupts the key |
| Exchange seed | `transformation/seeds/_seeds.yml` is UNI on Arbitrum and Base for October 2026 | Not a historical USDT label ledger |

Quality Gate's note on an Etherscan ABI fetch is accepted as their review, not re-fetched here. The Solidity file above is the contract source this pass read. It is a warning about which event families to look for, not a decoded log.

## Proposed design

Three history sources, one movement mart, five stages, one share. The stages below are the proposal that replaces the blocked wording. They become the specification only when Ian approves them.

### Comparable movement

One row in `usdt_movements` is one successful on-chain movement of this token, in that token's base units, counted once.

| Chain | A movement row | Issuance and destruction | Not a movement row |
|---|---|---|---|
| Ethereum | One `Transfer` log of the USDT contract, including a fee leg if the catalog shows the fee is its own log | `Issue`, `Redeem`, and `DestroyedBlackFunds` logs are their own rows with `family = issuance` or `family = destruction`. They are not inferred from a zero address. A `Transfer` to the zero address is `family = transfer` unless the catalog proves that implementation reduces supply with it | Failed receipts. A deprecated contract's forwarded call is read from the contract that actually emitted the log, which may be the upgraded address. The catalog has to name that address. This plan does not invent an upgraded address |
| TRON | One successful TRC-20 transfer log of `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | TRON issuance, destruction, and confiscation events are whatever the catalog proves on TRON. Ethereum's `Issue` / `Redeem` names are not copied | Failed transactions. Internal calls the catalog shows do not emit a TRC-20 log are not added on top of the log |
| Solana | One successful token-program instruction, outer or inner, counted once: transfer, mint-to, or burn, for this mint | Mint and burn instructions are `family = issuance` or `destruction`. A treasury transfer of already-minted tokens is `family = transfer` | A balance delta in addition to the instruction. `SetAuthority` and other non-amount instructions are not volume. They are inputs to owner resolution |

`family` is `transfer`, `issuance`, `destruction`, or null. Null means the catalog has not proved the row's role. Supply accounting uses rows the catalog marks `changes_supply = true`. A null `changes_supply` blocks publication. It is not treated as false, and a transfer is not assumed to change supply. The 2017 file's silence on zero-address transfers is not that mark.

Fee legs: if the catalog later shows two `Transfer` logs for one user call, both rows are stored. The 2017 `transfer` function debits the sender `_value`, credits the recipient `sendAmount`, and credits `owner` the fee. That file does not authorize the October 2026 rule. Whether S2 sums both logs is batch README decision 7, after a proof log from this window. Until that decision, `family` for a suspected fee leg stays null and the published mart stays empty. The rows remain in the extract.

Solana token-account owners follow [Solana owner intervals](./README.md#solana-owner-intervals): transaction index, then outer and inner instruction order, on an account lifetime that close-and-recreate resets. A join on slot is not the rule. Unresolved owners stay on the row with `owner_status = unresolved` and a null owner. Their volume is reported and is not dropped. Owner-self uses the owners effective at that instruction, not the last owner in the slot.

### Stages

Volumes are decimal-normalized token units: `base_units / 10^decimals`, using the decimals proven for that chain at that block or slot. Raw base units are stored and are never summed across chains. Decimals are not assumed to be 6. The fetched Solidity file takes decimals as a constructor argument and does not fix the value.

| Stage | Rule | Role |
|---|---|---|
| S1 | All successful movements: transfers + issuance + destruction | Diagnostic. Not the share baseline |
| S2 | `family = transfer` only | **Transfer-volume baseline.** The share an analyst quotes first |
| S3 | S2 minus exact self movements | Cumulative |
| S4 | S3 minus pairs whose both endpoints carry the same entity label under the label rule | Cumulative |
| S5 | S4 minus movements that touch an address labeled issuer treasury | Cumulative |

Self, by chain:

- Ethereum and TRON: `from` address equals `to` address. That is address-self.
- Solana: two flags. `account_self` means the same token account is source and destination. `owner_self` means the resolved authority owners are equal and both are resolved. S3 removes **owner-self** only. Account-self that is not owner-self stays in S3 and is reported as its own column so the two units are visible. Unresolved Solana endpoints are not called self and are not removed. Their volume is a disclosed column on every stage.

Labels:

- A label row has chain, network, address (or Solana owner), entity, role, public URL, evidence date, `effective_from`, `effective_to`, confidence, and `label_version`.
- Unknown addresses stay in every stage. They are never assigned an entity in order to remove them.
- S4 and S5 use a label only when both are true: the evidence date is on or before the movement, and the effective interval covers the movement's header time. The evidence-date rule is stricter than an effective interval alone. A label published after the transfer does not apply, even if `effective_from` was written to include that day. A current label with no effective interval does not apply. Confidence below the threshold in batch README decision 12 does not apply. Who may insert a row is that same decision.
- Same-entity removal is not evidence of wash trading. Issuer-treasury removal is not a "true" settlement figure.

Cumulative volumes are computed by removing a movement once, in the order S2 → S3 → S4 → S5. A movement that is both a self-transfer and a treasury touch is removed at the earliest stage and listed in that stage's incremental column only. Later stages do not subtract it again. Cumulative volume on a chain can stay flat or fall. It cannot rise. TRON's share can rise or fall.

Standalone masks, published beside the waterfall, each start from **S2**:

- S2 minus self only
- S2 minus same-entity only
- S2 minus treasury-touch only

### Share

For a stage `s` and a scope (one UTC day, or the whole window):

`share_s = V_TRON,s / (V_TRON,s + V_ETH,s + V_SOL,s)`

in token units. The whole-window share is the ratio of the three sums, not the average of the daily shares. A zero denominator is null. If any chain's manifest is missing, failed, or unknown, the panel share is null for that scope. It is not a two-chain share and it is not zero.

Label coverage (labeled volume over stage volume, and unresolved-owner volume) is a column next to the share, per chain and stage.

## Unresolved decisions for Ian

The pipeline stays blocked until these are answered. The choices above are proposals.

1. Approve this three-chain panel, or name a different panel. Batch README decision 5. A different panel is a new plan.
2. Approve S1–S5 and the standalone masks against S2, including "S3 removes Solana owner-self, computed at instruction order, and keeps unresolved volume." Same decision 5. The ordering rule itself is specified and is not this decision.
3. Label confidence threshold and who may add a row. Batch README decision 12. A row needs a public URL, an evidence date, and an effective interval. The threshold starts unpublished, so S4 and S5 remove nothing until Ian sets it. S2 does not wait on labels. The evidence-date rule above is already specified.
4. Ethereum fee-leg treatment, TRON issuance and confiscation names, and whether a zero-address transfer changes supply. Batch README decision 7. Those proofs do not exist. `changes_supply` stays null and blocks publication. It is not defaulted to false from the 2017 file.
5. The batch-log exception and the conflict guard. Batch README decisions 1 and 8. Both are implementation-blocking. Decision 1 does not add a TRON or Solana decoder to `ingestion/lib`.

Missing Solana block time is not a decision. An unassigned slot stays in the extract and fails every scope it can affect, including the whole window when no proved bracket exists. See the batch README header-time section. Dropping the slot, or failing only a day the null cannot name, is not the rule.

## Accounting and collection contracts

| Chain | Source of movements | Success rule | Finality stored on the manifest | Pagination |
|---|---|---|---|---|
| Ethereum | New stream, contract-wide, no `wallets` key. Events the catalog lists, at least `Transfer`, `Issue`, `Redeem`, `DestroyedBlackFunds`, `Deprecate` | Log is in a successful receipt. Receipt status is loaded for the matched transactions, the same way Uniswap sources store transactions as their own records | `target_head_number` and cursor hash, stored separately. A capped run may stop short of the head. The union of batches must cover the window | Pipes batching. A failed run keeps its committed batches and a later run resumes. A gap fails the extract. Decision 8 rejects conflicting payloads before upsert |
| TRON | New stream on Portal `tron-mainnet`. Contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` only | Successful transaction. The catalog defines the TRON success field. It is not copied from Ethereum | Solidified block number and id, as TRON names finality. A tip that is not solidified fails the extract | The source records the page cursor it followed. A short page that is not the end fails the run. Header time is checked before a day filter |
| Solana | New stream on Portal `solana-mainnet`, this mint only. Decoder stays in the package | Successful transaction, outer and inner instructions once, ordered by the lifetime key | Finalized slot. Null block time is unassigned and blocks every scope it can affect | Same pagination rule. Incomplete pages fail the run |

No wallet filter on any chain. The three Solana wallets in `solana-spl-balances` are not reused.

Decimals and a supply checkpoint (`totalSupply` or Solana mint supply) are call-source or decoded-state records at `B0 − 1` and `B1 − 1` equivalents. They are the reconciliation check for issuance and destruction rows. They are not the volume denominator. The volume denominator is the sum of transfer token-units under the stage rule.

TRON and Solana block-time mapping is part of the source, because `bj blocks` is EVM-only. A missing timestamp uses the header-time rule in the batch README. The event is kept. Every scope it could fall in fails, and the whole window fails when a bracket is not proved.

Every row names its network the way the source does: `ethereum`, `solana`, or `tron`, plus the Portal dataset (`ethereum-mainnet`, `solana-mainnet`, `tron-mainnet`). Addresses are stored as the issuer printed them. Staging does not lowercase TRON or Solana keys.

## Immutable schemas, grain, and manifests

| Model | Grain |
|---|---|
| `stg_<chain>__usdt_movements` | one log or one instruction. `value_base` numeric only after the text matches `^[0-9]+$`. `block_timestamp` timestamptz, null if unassigned. Native address text. Order columns non-null on Solana |
| `int_<chain>_usdt_movements` | that chain's grain plus `family`, `changes_supply`, `value_tokens`, owners, `owner_status`, self flags. Three files, not one shared rule file |
| `usdt_stage_status` | `day_utc` or `window`, chain, stage. Status `pass`, `fail`, or `unknown`. Measures null unless `pass`. Unassigned amount is a column here |
| `usdt_stage_daily` | `day_utc`, chain, stage, **pass rows only**. A failed day is missing, not a zero |
| `usdt_stage_window` | stage, pass only. Sums of passing days are not the window when any day failed. The window row exists only when the window status is `pass` |
| `usdt_share` | scope, stage, pass only. `share` is a number only on these rows |
| `usdt_label_ledger` | one label version per address. The model rejects a row with a null URL, null evidence date, or null effective interval |

`rule_version` and `extract_id` sit on every published row. `rule_version` covers the stage definitions and the fee-leg choice once decision 7 is closed. Shares from two versions are not plotted as one series. Run ids are the extract's contributing batches, not the freeze.

Normalized units use `numeric` division by an integer power of ten. The mart test checks `value_tokens * 10^decimals = value_base` exactly.

`usdt_share` has a row only when `panel_status = pass`. A failed panel is a row on `usdt_stage_status` with a null share, and it is absent from `usdt_share`. An analysis that returns a number from the status model fails its test.

## Dependencies

- Ian's approval of the decisions above. This is a hard gate, not a later polish item.
- Catalog entries `catalog/protocols/usdt-ethereum/`, `catalog/protocols/usdt-tron/`, `catalog/protocols/usdt-solana/`, each with proof logs. TRON and Solana catalogs have no pattern in `catalog/protocols/` beyond EVM examples (`uniswap`, `chainlink`, `op-standard-bridge`, `arbitrum-token-bridge`). The yaml shape can be copied. The proof method cannot pretend Portal EVM log calls work on TRON. The explore-protocol workflow's Portal MCP steps are EVM. TRON and Solana proofs need an explicit method in those NOTES, written when the proof is done.
- Portal datasets `tron-mainnet` and `solana-mainnet`, seen on the fetched list, with no client in the repo.
- Decoders for TRON logs and Solana instructions. New packages, not a flag on `evm-erc20-transfers`.
- A label research pass with URLs. Not started. `cex_addresses` is the wrong seed.
- The versioned extract and decisions 1 and 8. Decoders stay in the new packages.
- A load estimate before any backfill. USDT on these chains is expected to be a large extract. No count was taken in this pass. The history workflow forbids scanning the whole window to produce the estimate.

## Phased changes

Nothing in phase B or later starts while the status line is blocked.

### Phase A — definitions Ian can accept or reject

This pull request is phase A for the USDT question: the definitions in this file. No code.

### Phase B — after approval, prove contracts

| Path | Why | Owner |
|---|---|---|
| `catalog/protocols/usdt-ethereum/` | Ethereum event families, fee leg, deprecation, proof logs | BJ Ingestion |
| `catalog/protocols/usdt-tron/` | TRON-specific supply and transfer logs. Must not clone the Ethereum ABI from the names alone | BJ Ingestion |
| `catalog/protocols/usdt-solana/` | Mint, burn, transfer, token-account owner, inner instructions, proof transactions | BJ Ingestion |

### Phase C — extract

| Path | Why | Owner |
|---|---|---|
| `ingestion/sources/evm-usdt-movements/chains/ethereum/` | New table. The existing Ethereum transfer source is wallet-filtered, starts (per its comment) on 2026-11-01, and decodes only `Transfer`. `Issue` and `Redeem` would never land there | BJ Ingestion |
| `ingestion/sources/tron-usdt-movements/` | First TRON package. No `lower()` on addresses. Solidified-head stop, analogous to `finalizedHead` but not the EVM helper | BJ Ingestion |
| `ingestion/sources/solana-usdt-movements/` | Instruction history. `solana-spl-balances` cannot supply it | BJ Ingestion |
| `ingestion/sources/evm-usdt-supply/`, plus TRON and Solana supply readers in those packages or as sibling call sources | Checkpoint supply for the issuance check. Separate from volume | BJ Ingestion |
| `ingestion/sources.json` | Regenerated | BJ Ingestion |

### Phase D — transform

| Path | Why | Owner |
|---|---|---|
| `transformation/models/staging/ethereum/stg_ethereum__usdt_movements.sql` and `_ethereum__sources.yml` | Ethereum staging exists. New table, no `lower()` skipped: Ethereum addresses are lowercased, as every other EVM staging model does | BJ Transform |
| `transformation/models/staging/tron/` (new) | No TRON folder exists. Staging must not call `lower()` | BJ Transform |
| `transformation/models/staging/solana/stg_solana__usdt_movements.sql` and `_solana__sources.yml` | Solana folder exists for balances. Addresses stay case-sensitive | BJ Transform |
| `transformation/models/intermediate/usdt_panel/int_<chain>_usdt_movements.sql` | One file per chain for family, ordered owners, self flags, and normalization | BJ Transform |
| `transformation/models/marts/usdt_panel/` (`usdt_stage_daily.sql`, `usdt_stage_window.sql`, `usdt_stage_status.sql`, `usdt_share.sql`, yml) | Published marts are pass rows only. The status model keeps fail, unknown, and unassigned amounts | BJ Transform |
| `transformation/seeds/usdt_label_ledger.csv` and `transformation/seeds/_seeds.yml` | Column contract. No row without a URL. Not `cex_addresses` | BJ Transform |
| `transformation/tests/usdt_panel_*.sql` | Gates below | BJ Transform |
| `transformation/dbt_project.yml` | Shared view materialization | BJ Transform |

### Phase E — schedule and the answer

| Path | Why | Owner |
|---|---|---|
| `orchestration/pipeline/schedules.py` | Key `usdt_panel` only after approval | BJ Orchestration |
| `orchestration/tests/test_definitions.py` | Parent keys for the three chain intermediates | BJ Orchestration |
| `.claude/skills/blockjuice/references/question-spec.md` | Non-EVM heights and an exclusive UTC end. Shared with the other plans | BJ Skills & Reports |
| `transformation/analyses/usdt_panel_share.sql` | Selects `usdt_share` where `panel_status = 'pass'` | BJ Skills & Reports |
| `answers/usdt-panel-share/question.yaml` | Claim ceiling in `definitions`. Gitignored until a run | BJ Skills & Reports |

## Validation, coverage, and finality gates

1. All three chains are `pass` on the same `extract_id`, `rule_version`, window, and stage mask. One missing chain sets status `unknown` on `usdt_stage_status` and leaves `usdt_share` without that row. The five input-boundary fixtures apply. A shared Dagster run id is not this gate.
2. Finality evidence is `ethereum` cursor hash plus `target_head_number`, `solana` finalized slot, or `tron` solidified block id. The label `finalized` without the cursor and the target head stored separately fails. A capped run is acceptable only when the union of batches covers the window.
3. Decision 8 before upsert. Identical payloads are idempotent across runs. Conflicting payloads are preserved and the batch rolls back. Inner and outer Solana instructions do not share an id. Null transaction id or null instruction position fails before the day filter.
4. Amount text matches `^[0-9]+$` before a cast. No negative amount. No cross-chain sum of `value_base`.
5. Decimals non-null and constant, or a documented change with a per-range scale. A null decimals fails normalization.
6. `value_tokens * 10^decimals = value_base`.
7. Rows with `changes_supply = true` reconcile to the supply checkpoints. A null `changes_supply` fails the extract. It is not coerced to false. A transfer-only gap can still leave supply unchanged, so this gate does not prove S2 completeness. S2 completeness is the batch union plus receipt or instruction samples, on that extract. A missing expected supply call with zero dead letters fails.
8. S3 volume ≤ S2, S4 ≤ S3, S5 ≤ S4, per chain, per day and for the window. A test fails if a cumulative series rises.
9. Incremental removals sum to the difference between S2 and S5. A movement id appears in at most one incremental set.
10. Standalone masks are computed from S2, not from the previous cumulative stage.
11. Unresolved Solana owner volume is non-null as a column whenever Solana S2 is non-null.
12. Label rows used for S4 and S5 have URL, evidence date on or before the movement, effective interval covering the header time, and confidence at or above the approved threshold. A fixture with evidence dated after the transfer is ignored even when `effective_from` covers the day. A fixture with `effective_from` after the transfer is ignored too.
13. Zero denominator and incomplete panel produce no row in `usdt_share`. The status model holds null, not zero.
14. Header time matches before a day is assigned. A null Solana block time stays unassigned and fails every scope it can affect, including the whole window when no bracket is proved. It is not binned into a session-local date and it is not dropped.
15. TRON Base58 and Solana addresses in staging equal the raw text byte for byte.
16. The three Solana lifetime fixtures pass, including the slot-only join that must fail.

## Tests

- Source tests per chain: contract or mint filter, no wallet filter, id uniqueness for inner instructions, TRON address round-trip, Ethereum `Issue` stored as its own event name (dbt sets `family` only after decision 7). Conflict fixtures call the preserve-guard: same batch, later run, null transaction id, null log or instruction index.
- Unit tests on `int_<chain>_usdt_movements`: Ethereum `Issue` is issuance once the catalog says so; a proved fee plus a send amount are two stored rows whose S2 inclusion stays unpublished until decision 7; the three Solana lifetime fixtures (one transaction, two transactions in one slot, close then recreate); unresolved owner; TRON address-self; header mismatch; unassigned slot blocking the window. Catalog proof rows are used when they exist. The lifetime fixtures may be synthetic specification fixtures until then. They are not observations, and they are not derived by assuming the 2017 file matches this window.
- Mart tests for the monotonic stages, the ratio-of-sums window share, a missing chain absent from `usdt_share` and present as `unknown` on the status model, and the "cumulative volume cannot rise while share can" fixture (hand-written rows in a dbt unit test, labeled as a specification fixture).
- Seed test: `usdt_label_ledger` rejects a row without a URL.
- A test that `lower(tron_address)` is not equal to the stored address for a mixed-case fixture, so a copied EVM macro fails review. `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` contains both cases.

## Analyst UX

`question.yaml` definitions:

- panel: native USDT on TRON, Ethereum, and Solana
- transfer volume: S2, token units, successful movements with `family = transfer`
- share: TRON S2 over the sum of the three S2 volumes, for the named scope
- S3–S5: sensitivities, each named, not a preferred "true" volume
- self: address-self on Ethereum and TRON; owner-self on Solana at the instruction's place in the ordered lifetime, with account-self shown beside it

Charts, only after `panel_status = pass`: a waterfall from S1 to S5 per chain, and a daily S2 share with the other stages as separate lines. The title uses the sentence in the status section. It does not say settlement, dominance, or wash-trading-adjusted. The whole-window share is annotated as a ratio of sums. Label coverage and unresolved Solana volume are printed next to any S4 or S5 line so a reader can see how much the labels touched.

`bj report` includes the stage table and the definitions. An analyst does not describe S4 as a statistical bound.

## Risks

- The extract is likely to be large. Starting it before a short sample estimate, which this plan does not have, is how a backfill becomes unbounded. The workflow already says to put that estimate in front of the analyst.
- Ethereum USDT's live contract may have moved past the 2017 file via `deprecate`. Building the decoder from that file alone will miss logs on the upgraded address. The catalog proof is the mitigation, and it is not done.
- TRON event names are easy to borrow from Ethereum. The plan forbids that, and the risk remains if the TRON catalog is written by copying `TetherToken.sol`.
- Asymmetric labels will move S4 and S5 shares because one chain is better documented. The label-coverage column is the mitigation. It does not make the share a bound.
- Reusing `analytics.erc20_transfers` would apply the three-wallet filter and would miss `Issue` and `Redeem`.

## Explicit out of scope

- Any chain outside the approved panel.
- Stablecoins other than this USDT.
- Prices, including `analytics.token_prices` and `analytics.oracle_prices`.
- Wash-trading classifiers, hop limits, and size cutoffs.
- Editing `solana-spl-balances` addresses to "cover USDT."
- Treating the blocked specification as accepted because this file proposes a repair.
- A–H.
