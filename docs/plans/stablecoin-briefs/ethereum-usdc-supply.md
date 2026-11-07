# Ethereum USDC: gross mints and burns versus net change in Ethereum USDC supply

**Pipeline:** `usdc_supply`  
**Status:** Method accepted conditionally by Quality Gate. The historical SQL proposal is unexecuted and is not a validation gate. This document reports no mint, burn, or supply figure.  
**Phrase an analyst uses:** **net change in Ethereum USDC supply**. The series is total supply on Ethereum. It is not a liquidity series and it is not a fiat-inflow series.

Shared rules live in [README.md](./README.md).

## Objective

For Ethereum USDC at the Circle directory address, over the 30 complete UTC days

`[2026-10-08 00:00:00Z, 2026-11-07 00:00:00Z)`,

which is `[2026-10-07 21:00:00, 2026-11-06 21:00:00)` in America/Sao_Paulo (UTC−3),

publish each day's gross mints, gross burns, and net change in base units and in token units, plus the cumulative net change from the window start. Daily bins are UTC dates. The endpoint is excluded.

## Non-goals

- No fiat inflow, liquidity, circulating supply, redemption demand, price direction, or cross-chain migration.
- No treasury-adjusted circulation and no CCTP attribution. Circle's CCTP page, fetched 2026-11-07, describes USDC cross-chain movement as burn-and-mint. Related Ethereum burns and mints stay inside the totals. They are not matched to another chain.
- No Solana USDC comparison and no global USDC issuance.
- No reproduction of an external post's 30-day or 31-day figure. This window is the one declared here.
- The file circulated as `usdc-feasibility-proposal.sql` is not copied into `transformation/`. It is not corrected SQL and it is not run.

## Verified facts

| Item | Evidence | Limit |
|---|---|---|
| Ethereum USDC address `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | Circle's mainnet directory, fetched 2026-11-07, row Ethereum | The page does not state decimals, proxy history, or mint event semantics |
| CCTP moves USDC by burn-and-mint | Circle CCTP overview, fetched 2026-11-07 | Does not identify which Ethereum logs in this window are CCTP |
| The checked-in Ethereum transfer source includes this address and three wallets | `ingestion/sources/evm-erc20-transfers/chains/ethereum/addresses.json` | A transfer that touches none of the wallets is dropped (`source.ts`, `source.test.ts`) |
| That source's `START_BLOCK` comment says block `26316189` is the first block of 2026-11-01 UTC | `chains/ethereum/.env.example` | The comment was not checked against a header here. The date in the comment falls inside this window, so the checked-in start cannot cover 8 October even for those three wallets |
| Resuming after a cursor does not reread earlier blocks | `ingestion/lib/src/warehouse/stream.ts`, `workflows/history-source.md` | Removing `wallets` and running again leaves the omitted logs unloaded |
| `analytics.tokens` keeps the latest metadata reading. The metadata source accepts a pinned `BLOCK_NUMBER` and keys rows by block and token. The checked-in example uses `latest` | `tokens.sql`, `evm-erc20-metadata/src/source.ts`, `.env.example` | The mart is not a per-interval series. The source does not read `totalSupply` or implementation |
| Staging already casts a transfer timestamp to `timestamptz` and `value` to `numeric`. Amounts are stored as strings so jsonb does not round past 2^53 | `stg_ethereum__erc20_transfers.sql`, `ingestion/lib/src/warehouse/index.ts` | The existing mart is still wallet-filtered, so the cast is a pattern to copy, not a dataset to query |
| `classified_transfers` treats the zero address as category `bridge` | `classified_transfers.sql` | That category is not this pipeline's mint definition |

Historical mint and burn semantics through the proxy are **not** verified. Master-branch or present-day token code is not evidence for October 2026. The conditional acceptance of "transfer from the zero address is a mint, transfer to the zero address is a burn" stands only after the catalog proves those paths, and every other supply-changing path, for the implementations used in this window.

## Proposed design

A new Ethereum-only stream, `evm-usdc-transfers`, reads every `Transfer` log of `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` with no `wallets` key. `START_BLOCK` is the first Ethereum block whose header timestamp is greater than or equal to 2026-10-08 00:00:00Z, resolved with `bj blocks` when implementation runs. This plan does not hard-code that block number. Each run targets Portal's finalized head and may stop earlier under `maxBlocksPerRun`. Blocks after the window may be loaded. The published mart keeps events in `[B0, B1)` only after those event times match canonical headers.

A new call source, `evm-usdc-supply`, reads at explicit block numbers. The existing metadata source can also pin `BLOCK_NUMBER` to a historical block and key the row by block and token. Its checked-in example uses `latest`, and `analytics.tokens` keeps only the latest reading. That source still does not read `totalSupply` or implementation, so the supply calls are a new source:

- `totalSupply`
- `decimals`
- the implementation slot the catalog proves this proxy uses (EIP-1967 only if the proof says so)

at the post-state of block `B0 − 1`, the post-state of block `B1 − 1`, and the post-state of the last block before each UTC midnight in the window. `B0` is the first canonical block with timestamp `>=` the window start. `B1` is the first canonical block with timestamp `>=` the window end. The interval of events is `[B0, B1)`. Opening supply is the post-state at `B0 − 1`. Closing supply is the post-state at `B1 − 1`. `B0`'s events are not part of the opening supply. `B1`'s events are not in the window. The same midnight rule splits the days.

Receipt samples are a third call source: a small set of transaction receipts inside the range, including at least one catalog-proven mint and one catalog-proven burn if those shapes exist. They are checks against the raw logs.

Classification lives in one intermediate model, `rule_version` pinned:

- `from` zero and `to` non-zero: mint, after the catalog says this implementation's mints are that shape
- `to` zero and `from` non-zero: burn, on the same condition
- `from` zero and `to` zero: fail the build
- any other supply-changing log the catalog finds (a mint that does not use the zero address, a fee, a confiscation): its own column, and the zero-address rule is not applied to it

Until the catalog proof exists, the intermediate model emits no classified amounts. The status model is `unknown`. It does not fill zero mint or burn measures, and it does not assume the zero-address rule in order to print a chart.

The mart does not read `erc20_transfers` or `classified_transfers`.

## Unresolved decisions for Ian

1. The batch-log exception and the conflict guard. Batch README decisions 1 and 8. Both are implementation-blocking. Approving the batch log does not freeze inputs by itself. The versioned extract does, and it is specified in the batch README.
2. Acceptance of the catalog's mint and burn proof once it exists. Batch README decision 11. The proof is an implementation deliverable. Ian's acceptance is what moves `rule_version` from blocked to a published version.
3. If the proof finds a supply path that is not a zero-address `Transfer`, that path is in the totals. Same decision 11. Ian confirms the label on the chart (still "gross mints" and "gross burns," with a note of the path). The chart does not become a fiat series because the path was surprising.
4. Archive RPC for the boundary `eth_call`s. Batch README decision 10. The repo does not name an archive provider for this window. `BLOCK_NUMBER=finalized` on the balance source is the wrong block.

No panel decision belongs to this pipeline. The window, the address, and the exclusion of treasury adjustments are fixed by the conditionally accepted method.

## Accounting and collection contracts

### Collection

| Input | Contract |
|---|---|
| Logs | Every `Transfer` of the one contract in `[B0, B1)`, plus any non-Transfer supply log the catalog names. No wallet filter. Source name `ethereum`, Portal dataset `ethereum-mainnet` |
| State | `totalSupply` and `decimals` at `B0 − 1`, at `B1 − 1`, and at each daily closing block. Implementation identity at those blocks |
| Finality | `target_head_number` from `finalizedHead` (a number, not a hash) stored separately from the cursor number and cursor hash. Boundary calls use the block hash on the extract, not tag `latest` |
| Completeness | The union of committed batches covers `START_BLOCK` through at least `B1 − 1`, on one `extract_id`. A capped run need not reach the head. Every expected supply and receipt `callId` has a successful row in that extract. Zero dead letters with a missing call id fails |

### Arithmetic

All sums use integer base units. `numeric` in the warehouse is the copy of the digit string. A null amount fails the build because a SQL `sum` skips nulls. Negative amounts fail. Fractional amounts fail.

For a day whose manifest passed:

- `mint_base` = sum of mint amounts
- `burn_base` = sum of burn amounts, stored as a non-negative integer
- `net_change_base` = `mint_base − burn_base`
- token-unit columns divide by `10^decimals` from the supply read at that day's closing block, not from `analytics.tokens`
- `cumulative_net_change_base` is the running sum of `net_change_base` from 8 October inclusive. It is the window's net change. It is not `totalSupply`

Daily identity, necessary and not sufficient: opening `totalSupply` plus that day's `net_change_base` equals closing `totalSupply`. The window identity is the same from `B0 − 1` to `B1 − 1`.

Equal missing mints and burns preserve that identity. The extra gates are: the stream range is complete, receipt samples match, and each midnight supply read matches. A failed extra gate fails the day even when the identity holds.

A UTC day with `coverage_status = pass` and no mint or burn logs stores zeros on the published mart. A `fail` or `unknown` day is absent from `usdc_supply_daily` and present on `usdc_supply_status` with null measures. The chart reads the published mart, so it does not draw those days as zero bars. The status model is where an analyst sees the gap.

`burn_base` is non-negative in the table. The chart draws burns below zero by plotting the negation. The table does not store a negative burn.

### Time

`block_timestamp` is `timestamptz`. It is assigned to a day only after it equals the canonical header time for that block hash. The day is `(header_timestamp at time zone 'utc')::date`. The 30 dates are generated as dates from `2026-10-08` through `2026-11-06` inclusive on the status model. That generation does not add an integer to a timestamp and does not depend on the session time zone. A non-null timestamp that disagrees with the header fails the extract before this date cast.

### Labels

None. Treasury, CCTP messengers, and exchanges are not classified in this pipeline.

## Immutable schemas, grain, and manifests

| Model | Grain |
|---|---|
| `stg_ethereum__usdc_transfers` | one log. Columns include `block_number`, `block_hash`, `block_timestamp` timestamptz, `tx_hash`, `log_index`, `token`, `from_address`, `to_address`, `value` numeric, `_loaded_at`. Hash, transaction id, and log index are non-null before the day filter |
| `stg_ethereum__usdc_supply` | one call: block, token, `total_supply`, `decimals`, `implementation`, block hash |
| `int_usdc_classified` | one supply-changing log, with `kind` in `mint`, `burn`, or a catalog-named kind |
| `usdc_supply_status` | one row per `day_utc` in the 30-day spine, with `coverage_status` and null measures unless `pass` |
| `usdc_supply_daily` | one row per passing `day_utc` only |

`usdc_supply_daily` columns: `day_utc`, `mint_base`, `burn_base`, `net_change_base`, `mint_tokens`, `burn_tokens`, `net_change_tokens`, `cumulative_net_change_base`, `opening_supply_base`, `closing_supply_base`, `decimals`, `implementation`, `b0`, `b1`, `opening_block`, `closing_block`, `coverage_status` (`pass` only), `rule_version`, `extract_id`. Contributing `run_id` values live on the extract, not as a substitute for `extract_id`.

The Quality Gate noted that the unexecuted SQL's select list omitted `mint_base`, `burn_base`, `net_change_base`, coverage, and run ids. The measure columns are in this grain. Provenance is `extract_id`, which lists the runs. A build that cannot fill the measure columns on a `pass` day fails.

`rule_version` changes when the mint path changes. The answer folder records the version and the `extract_id`. Raw rows stay keyed by `<block>:<logIndex>`. A later run with the same payload is idempotent. A later run with a different payload does not replace `data` (decision 8).

Checks and the daily model both read that `extract_id`. Sharing a `dagster_run_id` with a second extract is a failed fixture, not a pass.

## Dependencies

- The versioned extract and decisions 1 and 8 in the batch README.
- `bj blocks ethereum 2026-10-08 2026-11-07` (or the equivalent from and to the workflow already uses) to pin `B0` and `B1`. Not run in this pass, so no block numbers are stated.
- Portal dataset `ethereum-mainnet`, already the URL in `evm-erc20-transfers/chains/ethereum/.env.example`.
- An archive node for historical `eth_call`. Not configured by name here. Decision 10.
- Catalog entry `catalog/protocols/usdc-ethereum/` with proxy upgrades and one proof log per supply path. Written at implementation time, not in this pull request.
- `analytics.tokens` is not the decimals source for this window. The metadata call source can store a pinned block, and that still does not provide `totalSupply` or the implementation. Joining the latest-only mart for decimals is a bug.

## Phased changes

### Phase A — prove the proxy

| Path | Why | Owner |
|---|---|---|
| `catalog/protocols/usdc-ethereum/protocol.yaml` | Address, proxy, implementation history, event signatures, proof logs. explore-protocol requires this before a source | BJ Ingestion |
| `catalog/protocols/usdc-ethereum/NOTES.md` | Which logs change supply in this window. The zero-address rule is written here only if the proofs show it | BJ Ingestion |
| `catalog/protocols/usdc-ethereum/abis/*.json` | ABIs the decoder uses | BJ Ingestion |

### Phase B — extract

| Path | Why | Owner |
|---|---|---|
| `ingestion/sources/evm-usdc-transfers/` with `chains/ethereum/` only | New table `raw.ethereum_usdc_transfers`. Does not edit `chains/ethereum/addresses.json` of `evm-erc20-transfers`, whose three wallets and November start block cannot answer this window | BJ Ingestion |
| `ingestion/sources/evm-usdc-supply/` | Boundary `totalSupply`, decimals, and the implementation slot the catalog names. The metadata source can pin a block for name, symbol, and decimals. It does not read these supply fields, and `analytics.tokens` keeps only the latest of those three | BJ Ingestion |
| `ingestion/sources/evm-usdc-receipts/` | Receipt samples for the completeness gate. A stream of logs does not store the receipt status | BJ Ingestion |
| `ingestion/sources.json` | Regenerated | BJ Ingestion |

The transfer source refuses a `wallets` key. `START_BLOCK` in `.env.example` is a comment that it must be set from `bj blocks` to `B0` before the first run, and the package test fails while the value is the sentinel `0`.

### Phase C — transform

| Path | Why | Owner |
|---|---|---|
| `transformation/models/staging/ethereum/_ethereum__sources.yml` plus `stg_ethereum__usdc_transfers.sql`, `stg_ethereum__usdc_supply.sql`, `stg_ethereum__usdc_receipts.sql` | Staging folder for the `ethereum` source already exists | BJ Transform |
| `transformation/models/intermediate/usdc_supply/int_usdc_classified.sql` | The only place the mint rule lives | BJ Transform |
| `transformation/models/marts/usdc_supply/usdc_supply_daily.sql`, `usdc_supply_status.sql`, `_usdc_supply__models.yml` | Published mart is pass days only. Status model holds the 30-day spine | BJ Transform |
| `transformation/tests/usdc_supply_*.sql` | Singular gates. They are not macros the unexecuted SQL already satisfied | BJ Transform |
| `transformation/dbt_project.yml` | Shared intermediate-view line | BJ Transform |

### Phase D — run surface

| Path | Why | Owner |
|---|---|---|
| `orchestration/pipeline/schedules.py` | Key `usdc_supply` | BJ Orchestration |
| `orchestration/tests/test_definitions.py` | The mart's parents are the new intermediate model and the manifest | BJ Orchestration |
| `transformation/analyses/usdc_supply_daily.sql` | Headline select of the 30 days | BJ Skills & Reports |
| `answers/usdc-ethereum-supply/question.yaml` | Written when the pipeline is run. Gitignored | BJ Skills & Reports |

## Validation, coverage, and finality gates

These replace the unexecuted SQL. They are the implementation of the eight static issues Quality Gate listed. Line numbers refer to that proposal so a reviewer can see the mapping. The proposal is not in the repo and is not executed.

| Gate | What it enforces | Static issue it closes |
|---|---|---|
| Header equality before any timestamp predicate | Every block in `[B0, B1)` is inside the union of committed batches. Each event joins its canonical header on hash. Event time equals header time. A non-null wrong time fails the extract. Null timestamp, null token, null chain, null `tx_hash`, and null `log_index` fail here, before a date filter. A count of missing fields taken after a timestamp filter does not see rows the filter dropped | Issue 1 (proposal lines 114–120) |
| Integer and identity record test | `from` and `to` are 20-byte hex. Amount text matches `^[0-9]+$` before a `numeric` cast. `block_number` and `log_index` are non-null and non-negative. `block_hash` and `tx_hash` are non-null. Zero-to-zero fails | Issue 2 (lines 124–127) and issue 4 (lines 155–156) |
| Conflict guard before upsert | Decision 8. Same id and different `data` preserves both payloads in `ops.source_conflicts` and does not replace `raw.data`, including a repeat on a later run. Identical data is idempotent. A post-load singular test is not this gate. `DISTINCT` is not this gate | Issue 3 (lines 121–123) |
| `timestamptz` day bin and a `date` spine | As in Accounting, after header equality. Session time zone cannot move a day | Issue 5 (lines 148, 152, 142–145) |
| Pass rows before zeros | `usdc_supply_daily` contains only `pass` days. A day with no logs on a pass day stores zeros. `fail` and `unknown` are missing there and null-measured on `usdc_supply_status` | Issue 6 (lines 159–160) |
| One extract | The daily model and the supply test read the same `extract_id`. Supply identity, implementation, receipt samples, header checks, and finality are bound to that id. A shared Dagster run id is not the freeze. The five boundary fixtures apply | Issue 7 |
| Column contract | `mint_base`, `burn_base`, `net_change_base`, `extract_id`, and coverage status are not optional on a published row | Issue 8 (lines 163–169) |
| Boundary blocks | Opening post-state is `B0 − 1`, closing is `B1 − 1`, events are `[B0, B1)`, hashes stored on the extract | Quality Gate accounting section |
| Cancelled omissions | Identity plus complete batch union plus daily supply reads plus receipt samples. A missing expected call with zero dead letters fails | Quality Gate: equality is not sufficient |
| Finality | `cursor_number` is at least `B1 − 1` and `cursor_hash` is non-null. `target_head_number` is stored beside it. `finalizedHead` does not return a hash, and a capped run may have stopped before the head. The string `finalized` is not this gate | `portal.ts`, `stream.ts` `upTo`, plus this window's end |

Zero-to-zero is a failing test with a fixture in the intermediate unit tests. It is not a comment.

## Tests

- Source tests: wallet key rejected; a log of another token dropped; a zero-to-zero log still extracted (classification fails later, so the raw layer can see the anomaly); amount `2^70` survives as a digit string. Conflict fixtures call the preserve-guard: same batch, later run, null `tx_hash`, null `log_index`.
- Unit test on `int_usdc_classified`: catalog proof rows for mint, burn, ordinary transfer (not a mint), and zero-to-zero (model error). A header-mismatch fixture never reaches the day spine.
- Singular tests for the gates in the table above, including "a `fail` status row is absent from `usdc_supply_daily`" and "supply identity can hold while a planted missing mint-and-burn pair fails the receipt or the range gate." The planted pair belongs in a unit fixture, not in production data. Also the five extract fixtures from the batch README.
- Published mart `unique` on `day_utc`, `not_null` on `extract_id`, `accepted_values` of `coverage_status` limited to `pass`. The status model accepts `pass`, `fail`, and `unknown`.
- `cumulative_net_change_base` on the last passing day equals the sum of `net_change_base`. The window's `net_change_base` equals closing `totalSupply` minus opening `totalSupply` when the supply gate passes. The cumulative column is that running net change. The test does not compare it with `totalSupply`.

## Analyst UX

`answers/usdc-ethereum-supply/question.yaml` definitions:

- gross mints: supply-increasing logs under `rule_version`, in USDC base units and in token units
- gross burns: supply-decreasing logs under the same rule
- net change in Ethereum USDC supply: mints minus burns, equal to closing total supply minus opening total supply when the gates pass
- cumulative net change: the running sum inside this window, not total supply
- day: UTC date

The chart is specified as daily mint bars above zero and burn bars below zero, with a second panel for cumulative net change. It reads `usdc_supply_daily` only. The subtitle carries the contract, `B0`, `B1`, both block hashes, `target_head_number`, the cursor hash, `rule_version`, and `extract_id`. Token units are labeled USDC. They are not labeled dollars. The status model is the place a missing day is visible. This pull request does not build the chart.

`bj report` publishes the 30-row analysis and the definitions. An analyst does not paste the unexecuted SQL into the answer.

## Risks

- USDC transfer volume for a full contract over 30 days was not estimated. The history workflow requires a short Portal sample before the backfill. This plan does not contain that count.
- A proxy upgrade inside the window that changes mint shape will pass a single present-day ABI and fail the supply identity or, worse, mis-classify while the identity still holds. The implementation read at every midnight is what makes that visible. If two implementations appear, `rule_version` cannot stay a single zero-address rule without Ian's decision 3.
- Building this by editing the existing Ethereum cursor would also change the wallet-filtered USDC rows already defined for `analytics.erc20_transfers`. The new package avoids that.

## Explicit out of scope

- Any USDC address except the Ethereum mainnet directory row. Circle's fetched table includes Base, Solana, Arbitrum, and others. They are not loaded.
- CCTP message tables, cross-chain matching, and "inflows."
- Treasury or blacklist adjustments.
- The unexecuted SQL file, as a model or as a check.
- `analytics.tokens` as the decimals source.
- A–H and the existing transfer pipeline's filters.
