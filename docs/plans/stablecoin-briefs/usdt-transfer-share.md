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

`family` is `transfer`, `issuance`, or `destruction`. Supply accounting for the check uses issuance and destruction rows plus any transfer row the catalog marks `changes_supply`. A transfer is not assumed to change supply.

Fee legs: if Ethereum emits two `Transfer` logs for one user call, both rows exist. S2 includes both, because each is a ledger movement of USDT. The plan does not drop the fee leg unless the catalog shows it is the same base units already counted, which the fetched `transfer` function does not show: the sender is debited `_value` and the recipient is credited `sendAmount`, with `fee` credited to `owner`. Those are two credits. Counting both logs counts both credits. Ian's decision 7 in the batch README confirms this after the proof log. Until that confirmation the Ethereum source still stores both logs, and the mart stays blocked.

Solana token-account owners are resolved at the instruction's slot. Unresolved owners stay on the row with `owner_status = unresolved` and a null owner. Their volume is reported and is not dropped.

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
- S4 and S5 use only labels whose evidence date is on or before the movement and whose effective interval covers the movement's timestamp. A current label with no effective interval does not apply. Confidence below the threshold Ian sets does not apply.
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

1. Approve this three-chain panel, or name a different panel. A different panel is a new plan.
2. Approve S1–S5 and the standalone masks against S2, including "S3 removes Solana owner-self and keeps unresolved volume."
3. Set the label confidence threshold and who may add a label row. This plan proposes: a row needs a public URL, an evidence date, and an effective interval, and the threshold starts unpublished so S4 and S5 ship with zero removals until Ian sets it. S2 does not wait on labels.
4. Confirm, after catalog proofs, the Ethereum fee-leg treatment and the TRON issuance and confiscation event names. Those proofs do not exist yet.
5. The shared `ingestion/lib` manifest exception in the batch README.
6. Solana missing block time: this plan proposes the slot stays in the extract and the day stays null, which fails that day's panel share. The alternative of dropping the slot is rejected in this proposal because it would under-count in silence.
7. Whether a transfer to the zero address on Ethereum or TRON reduces supply. The fetched Ethereum file's `destroyBlackFunds` does not use that shape. The plan proposes `changes_supply = false` for zero-address transfers until a proof says otherwise. Ian confirms after the proof.

## Accounting and collection contracts

| Chain | Source of movements | Success rule | Finality stored on the manifest | Pagination |
|---|---|---|---|---|
| Ethereum | New stream, contract-wide, no `wallets` key. Events the catalog lists, at least `Transfer`, `Issue`, `Redeem`, `DestroyedBlackFunds`, `Deprecate` | Log is in a successful receipt. Receipt status is loaded for the matched transactions, the same way Uniswap sources store transactions as their own records | Portal finalized head and hash | Pipes batching. A failed run resumes after the last committed cursor. Gaps fail coverage |
| TRON | New stream on Portal `tron-mainnet`. Contract `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` only | Successful transaction. The catalog defines the TRON success field. It is not copied from Ethereum | Solidified block number and id, as TRON names finality. A tip that is not solidified fails the manifest | The source records the page cursor it followed. A short page that is not the end fails the run |
| Solana | New stream on Portal `solana-mainnet`, this mint only | Successful transaction, outer and inner instructions once | Finalized slot | Same as TRON: incomplete pagination fails the run |

No wallet filter on any chain. The three Solana wallets in `solana-spl-balances` are not reused.

Decimals and a supply checkpoint (`totalSupply` or Solana mint supply) are call-source or decoded-state records at `B0 − 1` and `B1 − 1` equivalents. They are the reconciliation check for issuance and destruction rows. They are not the volume denominator. The volume denominator is the sum of transfer token-units under the stage rule.

TRON and Solana block-time mapping is part of the source, because `bj blocks` is EVM-only. A missing timestamp uses decision 6.

Every row names its network the way the source does: `ethereum`, `solana`, or `tron`, plus the Portal dataset (`ethereum-mainnet`, `solana-mainnet`, `tron-mainnet`). Addresses are stored as the issuer printed them. Staging does not lowercase TRON or Solana keys.

## Immutable schemas, grain, and manifests

| Model | Grain |
|---|---|
| `stg_<chain>__usdt_movements` | one log or one instruction. `value_base` numeric from a digit string. `block_timestamp` timestamptz or null. Native address text |
| `int_usdt_movements` | the same grain plus `family`, `changes_supply`, normalized `value_tokens`, `owner_from`, `owner_to`, `owner_status`, self flags |
| `usdt_stage_daily` | `day_utc`, chain, stage. Stage volume, incremental removal, cumulative volume |
| `usdt_stage_window` | stage. Sums across days |
| `usdt_share` | scope (`day` or `window`), scope key, stage. `share` numeric or null, denominator, `panel_status` |
| `usdt_label_ledger` | one label version per address. The seed is the input. The model rejects a row with a null URL, null evidence date, or null effective interval |
| `usdt_coverage_manifest` | one chain, one run. `pass` only when all three chains pass, for the panel row. Per-chain status stays visible |

`rule_version` covers the stage definitions and the fee-leg choice. A change increments it. Shares from two versions are not plotted as one series.

Normalized units use `numeric` division by an integer power of ten. The mart test checks `value_tokens * 10^decimals = value_base` exactly.

The panel mart emits a share only when `panel_status = 'pass'`. Otherwise `share` is null and a test fails if a report analysis returns that row as a number.

## Dependencies

- Ian's approval of the decisions above. This is a hard gate, not a later polish item.
- Catalog entries `catalog/protocols/usdt-ethereum/`, `catalog/protocols/usdt-tron/`, `catalog/protocols/usdt-solana/`, each with proof logs. TRON and Solana catalogs have no pattern in `catalog/protocols/` beyond EVM examples (`uniswap`, `chainlink`, `op-standard-bridge`, `arbitrum-token-bridge`). The yaml shape can be copied. The proof method cannot pretend Portal EVM log calls work on TRON. The explore-protocol workflow's Portal MCP steps are EVM. TRON and Solana proofs need an explicit method in those NOTES, written when the proof is done.
- Portal datasets `tron-mainnet` and `solana-mainnet`, seen on the fetched list, with no client in the repo.
- Decoders for TRON logs and Solana instructions. New packages, not a flag on `evm-erc20-transfers`.
- A label research pass with URLs. Not started. `cex_addresses` is the wrong seed.
- The shared manifest writer.
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
| `transformation/models/intermediate/usdt_panel/` | Family, owners, self flags, normalization | BJ Transform |
| `transformation/models/marts/usdt_panel/` (`usdt_stage_daily.sql`, `usdt_stage_window.sql`, `usdt_share.sql`, `usdt_coverage_manifest.sql`, yml) | The panel mart. One folder for all three chains | BJ Transform |
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

1. All three chains have a pass manifest for the same `rule_version`, the same window, and the same stage mask. One missing chain sets `panel_status` to `unknown` and nulls the share.
2. Finality text is `ethereum:finalized`, `solana:finalized`, or `tron:solidified`, each with a stored hash or block id. Any other text fails.
3. Unique movement ids. Inner and outer Solana instructions do not share an id.
4. No null amount, no negative amount, no cross-chain sum of `value_base`.
5. Decimals non-null and constant, or a documented change with a per-range scale. A null decimals fails normalization.
6. `value_tokens * 10^decimals = value_base`.
7. Issuance and destruction rows reconcile to the supply checkpoints under the catalog's `changes_supply` marks. A transfer-only gap can still leave supply unchanged, so this gate does not prove S2 completeness. S2 completeness is the cursor range plus receipt or instruction samples.
8. S3 volume ≤ S2, S4 ≤ S3, S5 ≤ S4, per chain, per day and for the window. A test fails if a cumulative series rises.
9. Incremental removals sum to the difference between S2 and S5. A movement id appears in at most one incremental set.
10. Standalone masks are computed from S2, not from the previous cumulative stage.
11. Unresolved Solana owner volume is non-null as a column whenever Solana S2 is non-null.
12. Label rows used for S4 and S5 have URL, evidence date, effective interval, and confidence at or above the approved threshold. A label with `effective_from` after the transfer is ignored, and a test fixture covers that.
13. Zero denominator and incomplete panel produce null shares, not zeros.
14. Timestamps are `timestamptz`. A null timestamp fails the day (decision 6) rather than landing in a session-local date.
15. TRON Base58 and Solana addresses in staging equal the raw text byte for byte.

## Tests

- Source tests per chain: contract or mint filter, no wallet filter, id uniqueness for inner instructions, TRON address round-trip, Ethereum `Issue` row not classified as a zero-address transfer inside the source (the source only sets the event name; dbt sets `family`).
- Unit tests on `int_usdt_movements`: Ethereum `Issue` is issuance; a fee plus a send amount are two transfer rows; Solana owner-self versus account-self; unresolved owner; TRON address-self. Fixtures come from catalog proof rows once those exist. Until they exist, the unit tests are not invented from the 2017 Solidity file alone.
- Mart tests for the monotonic stages, the ratio-of-sums window share, the null share when one chain is dropped, and the "cumulative volume cannot rise while share can" fixture (a fixed three-chain example with hand-written rows in a dbt unit test).
- Seed test: `usdt_label_ledger` rejects a row without a URL.
- A test that `lower(tron_address)` is not equal to the stored address for a mixed-case fixture, so a copied EVM macro fails review. `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` contains both cases.

## Analyst UX

`question.yaml` definitions:

- panel: native USDT on TRON, Ethereum, and Solana
- transfer volume: S2, token units, successful movements with `family = transfer`
- share: TRON S2 over the sum of the three S2 volumes, for the named scope
- S3–S5: sensitivities, each named, not a preferred "true" volume
- self: address-self on Ethereum and TRON; owner-self on Solana, with account-self shown beside it

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
