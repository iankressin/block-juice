# Lighter account ledger and L1 settlement: implementation plan (plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `.claude/skills/blockjuice/references/layers.md`, the Add a source section of `docs/architecture.md` and plan 1 (`docs/plans/2026-11-17-lighter-market-data.md`) before any task. Plan 1 lands first; this plan uses its code and marts as written there.

**Goal:** Load Lighter's public account data and L1 batches, link each deposit, withdrawal and transfer to the Ethereum transactions that settled it, and rebuild each listed account's ledger with Lighter's own readings to check it against.

**Architecture:** Eight call sources load raw replies. Three read the Explorer: L1 batches, account logs (each with a `logs/{hash}` lookup for its money moves) and hourly tx counts. Five read the exchange API: account snapshots, the account value series (`pnl`), assets, system config and public pools. They add an Explorer client, paced by request weight, and an account resolver to plan 1's `@ingestion/lib/lighter`. dbt turns each batch into a block range with its L1 hashes and times, joins every money move to the batch that holds its block, and stacks money moves, plan 1's fills and funding (from plan 1's hourly rates) into one ledger per account. Warn tests check the ledger against Lighter's daily flows and against position and collateral snapshots.

**Tech Stack:** as plan 1: TypeScript on `@ingestion/lib` (Node 24, zod 4), dbt on Postgres, Dagster through `PIPELINES`. No new dependency.

**Spec:** the user's request of 2026-11-17 ("implement support for all the read methods and create marts that make sense to the API and the chain design"; data reads only, public endpoints first, several plans), plan 1's Decision 1, and two goals: (1) link withdrawals, deposits and transfers to L1 batches: L2 tx → block → the batch whose range holds it → that batch's commit, verify and execute hashes and times; (2) rebuild historical balances and positions per account from public logs, plan 1's fills and the batches, and check them against snapshots. *What we know* holds the rest; each fact there comes from a live reply on 2026-11-17.

## What we know

**Hosts and limits.** The Explorer, `https://explorer.elliot.ai/api/`, allows 45 weight a minute per IP, burst 45. Weights: `accounts/:p/logs` 4, `blocks/:id` 5, `search` 3, `accounts/:p/positions` 2, every other path 1. It answers errors as `{"error":"…"}`: 400 `invalid pubDataType=Nope`, 404 `batch=28909 not found with block=0`, 404 `log deadbeef not found`. An unknown account's logs are `[]`, not an error. The exchange API is as plan 1 says: 60 requests a minute; an unknown index answers 400 `{"code":29404,"message":"not found"}`, an unknown L1 address 400 `{"code":21100,"message":"account not found"}`. Dagster runs at most `BJ_INGESTION_CONCURRENCY` sources at once, 4 by default (`orchestration/pipeline/concurrency.py`).

**What the Explorer holds.** Batches from 28910 on, whose first block, 41849406, is at 2025-08-25 15:28:03 UTC; 28909 and earlier answer 404. Account 1000's `pnl` inflow rises from 2025-03-13, but its oldest `L1Deposit` log is from 2025-09-10: no account log predates 2025-08-25. At 13:14 UTC `/total` gave 391,292,158 blocks, 270,105 batches and 1,066,460 accounts.

**Batches.**

| Reply | Fields |
|---|---|
| `GET /batches` | 20 recent batches ordered by `updated_at`, not by number: `batch_number, updated_at, batch_size, batch_status, batch_details`. Includes new batches with `batch_status` null and `batch_details` `{}`. Takes no `limit`. |
| `GET /batches/{id}` | `batch_number, updated_at, batch_details {commit_tx_hash, verify_tx_hash, execute_tx_hash}, blocks [{block_number, updated_at, total_transactions}], status_changes [{hash, updated_at, batch_status}]`. About 152 KB for 1600 blocks. |

- A batch is a contiguous block range, and consecutive batches meet: 270062 holds 391215230–391216829, 270063 391216830–391218429, 270064 391218430–391220029. Sizes vary: 338 to 713 blocks in batches 28910 to 29143, 427 in 109274, 1600 in every batch read from November 2026.
- About 830 batches a day now. Batch 268824 holds 2026-11-16 00:00:00 UTC; 268825 starts at block 389236030 at 00:00:23; the head was 270105 at 13:14 on 2026-11-17. (Since batch 100000 the average is about 505 a day.)
- Status goes `committed` → `verified` → `executed` (270062: 11:54:23, 12:08:59, 12:08:59), or `committed` → `nothing_to_execute` (270064: 11:56:59, then 12:14:35, carrying the verify hash; no execute hash). Batches holding a withdrawal (109274, 116950) or a deposit (269235) went to `executed`; an entry of account 150000 for a transfer shows `nothing_to_execute`. So `nothing_to_execute` marks a verified batch with no L1 work left: it is final, like `executed`. One execute tx can close several batches: 270092 and 270093 share execute hash `0x3446be37…`.
- L1 commits can lag by hours. Batch 270063's blocks (11:46–11:47) were committed at 11:55, but batch 269235, which holds a deposit made at 2026-11-16 11:09:41, was committed at 18:03:35 and executed at 18:08:47.

**Account logs** (`GET /accounts/{index}/logs?pub_data_type=…&limit=…&offset=…`).
- Newest first, `limit` up to at least 100, `offset` paging. Entries: `tx_type, hash, time, pubdata {<kind>_pubdata: {…}}, pubdata_type, status`. No block number.
- `pub_data_type` takes several types **only comma-separated**. For account 1000, `pub_data_type=L1Deposit&pub_data_type=WithdrawV2` returned 9 deposits and no withdrawal; `pub_data_type=L1Deposit,WithdrawV2` returned the withdrawal and the 9 deposits. A list of all 39 non-trade types in one parameter worked. An unknown type answers 400.
- Values are decimal strings (`"amount":"104503.000000"`), assets are symbols (`"asset_index":"USDC"`, `"LIT"`) and routes are `PERPS` or `SPOT`. One exception: `deleverage_pubdata_with_funding.quote` is an integer string (`"100958557736"`) next to a decimal `size` (`"0.90000"`).
- V1 and V2 shapes coexist. `l1_deposit_pubdata {l1_address, usdc_amount, account_index}`; `l1_deposit_pubdata_v2 {account_index, l1_address, asset_index, route_type, accepted_amount}`; `withdraw_pubdata {from_account_index, usdc_amount}`; `withdraw_pubdata_v2 {from_account_index, asset_index, route_type, amount}`; `l2_transfer_pubdata {from_account_index, to_account_index, usdc_amount}`; `l2_transfer_pubdata_v2 {from_account_index, to_account_index, fee_account_index, asset_index, from_route_type, to_route_type, amount, usdc_fee}`. A transfer with `from = to` moves funds between one account's routes (account 1000, 2025-12-30 08:07: SPOT → PERPS, 104508.6 USDC).
- Each fill gets its own hash. An order of 313004 that filled twice against maker 702389 at 12:19:09.815 shows as an `L2CreateOrder` entry (size 0.0071) and an `InternalClaimOrder` entry (0.3895) with a made-up hash `000000234fdcd5fa000001a1e9726177…`. No hash repeated within any of the eight pages checked.
- Volume: 313004's 100 newest `TradeWithFunding` entries span 11:47:58 to 13:21:00 on 2026-11-17, about 1,550 a day, or 16 pages. Its plain `Trade` entries, over 100K a week, are what a walk must skip.

**Log details** (`GET /logs/{hash}`): the entry plus `block_number` and `batch_number` (null until batched). It answers for old entries: the `L1Withdraw` of account 1000 at 2025-12-30 08:38:14 gives block 137652420 and batch 109274, whose range 137652412–137652838 holds it; that batch was committed at 10:50:11, verified at 11:31:11 and executed at 11:33:23 (`0x23a3d85c…`). The deposit `00000000001e5aa83d…` of account 693073 gives block 389893328 and batch 269235 (389892030–389893629, executed at 18:08:47, `0x0fc6217e…`).

**`tx` lookups.** `GET /api/v1/tx?by=hash` found a tx from 2026-11-10 and answered 400 `{"code":21500,"message":"transaction not found"}` for txs from 2025-12-30 and 2026-01-10. `txFromL1TxHash` with a batch's commit hash gave the same 21500: it takes the Ethereum hash of a deposit.

**Account value (`GET /api/v1/pnl?by=index&value=…&resolution=…&start_timestamp=…&end_timestamp=…&count_back=0`, times in seconds).**
- Fields per point: `timestamp, trade_pnl, trade_spot_pnl, inflow, outflow, spot_inflow, spot_outflow, pool_pnl, pool_inflow, pool_outflow, staking_pnl, staking_inflow, staking_outflow, pool_total_shares, volume`. Every field but `volume` is a running total since the account began.
- `1d` gives one point per UTC midnight from the account's first day, whatever the start (account 1000: 616 points from 2025-03-13 when asked from 2025-01-01), then one more point at the request time. `1h` answered 7 days (169 points) and refused 10 with 400 `{"code":22403,"message":"time range exceeds maximum allowed range for the specified resolution"}`.
- `inflow − outflow + trade_pnl` is the account's perps value. Account 1000: 156508.908444 − 153478.114476 − 3030.185271 = 0.608697, its `collateral` and `total_asset_value`. Account 313004 at 12:16:53: 20006.337415 − 4.867955 + 77970.108827 = 97971.578287, its `total_asset_value` (97971.57828700001) read the same minute.
- Day-to-day changes of `inflow` and `outflow` are the account's USDC money moves, each fee included. Account 20000, point 2025-12-31 against 2025-12-30: `outflow` +1903.9 = its transfer of 1900.9 plus the 3.000000 `usdc_fee`; `inflow` +1772.799436 = its SPOT → PERPS move of 1758.29 plus a pool burn of 14.509436; `spot_outflow` +1758.29; `pool_outflow` +14.509436. Account 1000 on 2025-12-30: `inflow` +104508.6 (SPOT → PERPS) and `outflow` +104508.0 (a withdrawal of 104503 and a transfer of 5). On 2025-10-11: a burn of 7399.753218 raised `inflow` and `pool_outflow` by that amount, and a v1 transfer of 7399.75 raised `outflow`. A mint counts as `outflow` and `pool_inflow` (2025-03-14, 161.998465). A transfer of 652.4 LIT moved none of these fields. The point at midnight D holds the totals up to D.

**Account snapshots** (`GET /api/v1/account?by=index&value=…`): `accounts[0]` with `index, l1_address, account_type, status, collateral, available_balance, total_asset_value, cross_asset_value, cross_initial_margin_requirement, cross_maintenance_margin_requirement, transaction_time` (µs), `positions [{market_id, symbol, sign, position, avg_entry_price, position_value, unrealized_pnl, realized_pnl, total_funding_paid_out?, liquidation_price, margin_mode, allocated_margin, initial_margin_fraction, …}]`, `assets [{symbol, asset_id, balance, locked_balance, margin_mode, margin_balance, multiplier}]`, `shares`, `pending_unlocks`. `collateral` leaves out unrealized pnl: 313004 had collateral 97972.003001, unrealized −0.424714 and total value 97971.578287. `position` is unsigned and `sign` is 1 or −1 (313004 at 13:3x: ETH sign −1, position 1.2821). `total_funding_paid_out` is missing on some positions and was 0 on a position just opened. `accountsByL1Address` lists every account of an address as `sub_accounts`. Explorer `accounts/{p}/positions` and `/assets` return the same positions and balances with fewer fields.

**Reference endpoints.** `systemConfig`: `liquidity_pool_index` 281474976710654, `staking_pool_index` 281474976624800, `funding_fee_rebate_account_index` 713888, `market_maker_incentive_account_index` 723106, `fee_collector_account_index` 281474976496476, plus cooldown, lockup and integrator fee caps. `assetDetails`: 13 assets, such as USDC (id 3, `decimals` 6), ETH (1, 8) and LIT (2, 8), with L1 address and decimals, margin mode, caps and `index_price`. `publicPoolsMetadata?filter=all&index=I&limit=100`: `index` is a cursor; the reply lists pools with `account_index ≤ I`, highest first. From I = 281474976710655 it returned 100 pools, from the LLP (281474976710654, `account_type` 3) down to 281474976698600; I = 0 returned none.

**Hourly tx counts** (`GET /stats/tx?aggregation_period=1h`; `day` answers `invalid aggregation_period: day`): `{"data":{"chart":{"types":["timestamp","count","uopsCount"],"data":[[1759363200,3571651,3571651],…]}}}`, 9,878 hourly points from 2025-10-02 00:00 UTC with no gap, about 289 KB. The last point is the current hour.

**Funding prefix sums.** `trade_pubdata_with_funding` carries the market's `funding_rate_prefix_sum`. On ETH it moved once between 11:47 and 13:21 on 2026-11-17: at 13:00:01, from 36577479997 to 36579121156. The step, 1,641,159, is 10^8 × 0.01641159, the `fundings` value for 13:00 (direction long). The 12:00 value was 0.00000000, and the prefix did not move at 12:00. All 100 of 313004's entries in that span were as taker and carried one of these two prefixes, so the type does not say which side settled funding.

**Fast withdrawals.** Account 675395 received 95 `L2TransferV2` in 13 hours, most with `usdc_fee` 1.000000, and made 5 withdrawals. The docs describe a fast withdrawal as a transfer to the fast-withdraw pool; 675395 is likely that pool. Only plan 3's `fastwithdraw/info` names it.

**Not yet proven, owned by Task 1:** which oldest day `tx` still answers (P18); that no account log repeats a hash over a three-day walk (P19); that every deposit and withdrawal in the check window lands in an `executed` batch (P20); the sign of a funding payment against collateral (P21).

## Decisions

1. **Endpoints.** In plan 2, each read by a source:

   | Host | Endpoint | Use |
   |---|---|---|
   | Explorer | `batches/{id}`, `/batches` | `lighter-batches`; `/batches` gives the head |
   | Explorer | `accounts/{index}/logs`, `logs/{hash}` | `lighter-account-logs` |
   | Explorer | `stats/tx` | `lighter-tx-stats` |
   | Exchange | `account`, `accountsByL1Address` | `lighter-accounts`; `accountsByL1Address` resolves the L1 addresses a source lists |
   | Exchange | `pnl` | `lighter-pnl` |
   | Exchange | `assetDetails`, `systemConfig`, `publicPoolsMetadata` | `lighter-assets`, `lighter-system-config`, `lighter-public-pools` |

   Moved out of plan 2, each with its reason (Task 1 records them in `vendor.yaml`'s `inventory`):
   - `tx`, proof only: it forgets old txs; `logs/{hash}` gives block and batch for any tx since 2025-08-25.
   - `txFromL1TxHash`, out: it takes an Ethereum deposit hash, and no plan-2 source reads Ethereum. A later source on the ZkLighter contract (`0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7`) can use it.
   - Explorer `accounts/{p}/positions` and `/assets`, proof only: `account` returns the same with more fields, under the exchange API's separate limit.
   - Explorer `blocks`, `blocks/{id}`, out: a batch reply lists every block's time and tx count; `blocks/{id}` weighs 5 and adds only a sample of logs and a market price list. `/total` and `search`, out: counts and a lookup that the batches and logs already hold.
   - `aggregatedTrades`, out: plan 1's S3 trades hold every fill with its position and pnl; this endpoint regroups them by order, 100 at a time under the 60-a-minute limit.
2. **Sources.** Eight packages, all `name: "lighter"`:

   | Package | `table` | Raw table | Input |
   |---|---|---|---|
   | `lighter-batches` | `batches` | `raw.lighter_batches` | none |
   | `lighter-account-logs` | `account_logs` | `raw.lighter_account_logs` | `addresses.json` |
   | `lighter-accounts` | `accounts` | `raw.lighter_accounts` | `addresses.json` |
   | `lighter-pnl` | `pnl` | `raw.lighter_pnl` | `addresses.json` |
   | `lighter-tx-stats` | `tx_stats` | `raw.lighter_tx_stats` | none |
   | `lighter-assets` | `assets` | `raw.lighter_assets` | none |
   | `lighter-system-config` | `system_config` | `raw.lighter_system_config` | none |
   | `lighter-public-pools` | `public_pools` | `raw.lighter_public_pools` | none |

   Each `addresses.json` is `{ "accounts"?: number[], "l1_addresses"?: string[] }`, shipped as `{ "accounts": [313004, 693073] }`: 313004 trades all day, and 693073 made 5 deposits on 2026-11-16 and 18 transfers since.
3. **Shared code** goes in `ingestion/lib/src/lighter/`: `explorer.ts` (the Explorer client) and `accounts.ts` (the `addresses.json` schema and `resolveAccounts`). Both are additive; plan 1's files do not change. A source reads by index only: L1 addresses resolve through `accountsByL1Address`, so no source asks the Explorer what an address path means.
4. **The account-logs source looks up its own entries.** No source may read another source's table, and only `logs/{hash}` gives an entry's block. So `lighter-account-logs` walks each account's log and, in the same run, calls `logs/{hash}` for each entry whose type is in `DETAIL_TYPES` (money moves, margin, pool, staking and position exits). Those are rare: none of 313004's 100 newest ledger entries, 3 to 8 of 100 for accounts 1000 and 150000. The walk skips plain `Trade` entries, which plan 1 loads from S3, by asking for `LEDGER_TYPES`, every type but `Empty` and `Trade`, in one comma-separated `pub_data_type`. Records are keyed `log:<account>:<hash>`, so an entry that new entries push onto the next page is written once, and a transfer between two listed accounts sits in both accounts' logs.
5. **Batch progress.** A batch is final once a status change is `executed` or `nothing_to_execute`. The checkpoint `{ origin, next }` keeps the first batch not yet final; each run reads from `next` to the head, so committed batches are read again until they settle. `origin` is the batch holding `START_TIME`, found by bisection on each batch's first block time (about 18 reads, once per `START_TIME`); before 28910 it is 28910. Replies are kept as sent, the 1600-block list included (Decision 13).
6. **Rate budget.** The Explorer client spaces requests by weight: a request starts at least `w × 60000 / LIGHTER_EXPLORER_WEIGHT_PER_MINUTE` ms after the previous one started, `w` being the previous request's weight. Shares in `.env.example`: batches 25, account logs 15, tx stats 5, so all three at once use 45. 429, 405, 5xx and network errors wait 2 s, 10 s, then 60 s, as in plan 1. Exchange-API sources keep plan 1's `LIGHTER_REQUESTS_PER_MINUTE=15`; with at most four sources at once that stays at 60.
7. **Readings and served history.** `lighter-accounts`, `lighter-assets`, `lighter-system-config` and `lighter-public-pools` add a reading per run, keyed by what they read and `read_at`, the time `extract` starts. `lighter-pnl` reads each account's whole `1d` series from `START_TIME` and the last 7 days of `1h` every run, keyed by account, resolution and point time, and drops the point at the request time, which is not on the resolution's boundary.
8. **Funding comes from plan 1's data.** The prefix sum steps by 10^8 × the hourly `fundings` value, so the funding an account pays for hour `h` in market `m` is its position at the tick times that value. dbt computes it from plan 1's `lighter_account_fills` and `lighter_funding_rates`. The Explorer's `TradeWithFunding` entries are still loaded (about 16 pages a day for a busy taker) and a warn test checks their prefix steps against the rates.
9. **Ledger scope.** `lighter_account_ledger` holds every change to a listed account's holdings that the data can price: USDC moves on either route, other assets' moves, perp fills (realized pnl less fees), funding and position exits. Spot fills stay out until the fee asset of a spot fill is proven. Staking and margin moves appear with a null `amount`: their sign is unproven.
10. **Pipeline.** Every source joins plan 1's `lighter` pipeline (cron `30 7 * * *`). Intermediate models are views; marts are tables.
11. **Marts.**

    | Mart | One row per | Key |
    |---|---|---|
    | `lighter_batches` | L1 batch | `batch_number` |
    | `lighter_account_movements` | leg of a money, margin, pool or staking entry in a listed account's log | `id` = `<hash>:<account>:<leg>` |
    | `lighter_account_ledger` | change to a listed account's holdings: movement leg, perp fill, funding hour or position exit | `id` |
    | `lighter_account_value_history` | account, resolution, point time | `id` |
    | `lighter_account_snapshots` | account, reading | `id` = `<account>:<read_at>` |
    | `lighter_account_position_snapshots` | account, market, reading | `id` |
    | `lighter_account_asset_snapshots` | account, asset, reading | `id` |
    | `lighter_tx_stats` | hour | `hour` |
    | `lighter_assets` | asset, latest reading | `asset_id` |
    | `lighter_system_accounts` | system role, latest reading | `role` |
    | `lighter_public_pools` | pool, reading | `id` |
12. **Seam for plan 3.** Plan 3's withdrawal, deposit and transfer histories join `lighter_account_movements` on `hash` for block, batch and L1 hashes. For accounts plan 2 does not list, plan 3's source calls `logs/{hash}` through the same Explorer client and its models join `lighter_batches` on `block_number between first_block and last_block`, as `int_lighter_account_movements` does.
13. **For a person to confirm.** Each has the default this plan builds:
    - Keep batch replies as sent, about 152 KB each, 830 a day (some 125 MB of JSON a day before Postgres compresses it). The alternative, one record per block, is the same data split up.
    - Load `TradeWithFunding` entries (16 pages a day for a busy taker) only to check prefix steps; leaving them out saves Explorer budget and loses that check.
    - Leave out `aggregatedTrades`, `tx`, `txFromL1TxHash`, Explorer positions, assets and blocks, for the reasons in Decision 1.
    - Leave spot fills out of the ledger.
    - Read snapshots once a day with the `lighter` pipeline. An hourly pipeline would give more readings to check against.

## Global Constraints

- Everything in plan 1's Global Constraints holds: Node 24 and pnpm 10.17.0 through `mise`; one source per package with `name: "lighter"`; `.env.example` shape; raw records as sent with 64-bit integers as strings; `readJson` inside `extract`; tests on `node:http` fakes, never the network; `pnpm generate-sources` after adding a source; prose rules; commit trailer.
- No new dependency. Plan 1's files under `ingestion/lib/src/lighter/` keep their exports; this plan only adds files and re-exports.
- `.env.example` defaults keep checks short: `START_TIME=2026-11-16T00:00:00Z` for `lighter-batches` and `lighter-account-logs`, `START_TIME=2026-11-10T00:00:00Z` for `lighter-pnl`.
- Explorer shares: `LIGHTER_EXPLORER_WEIGHT_PER_MINUTE=25` in `lighter-batches`, `15` in `lighter-account-logs`, `5` in `lighter-tx-stats`. A check run alone may set 45.
- Never call an Explorer path with an L1 address, and never send `pub_data_type` twice in one request.
- Plan 2 calls no endpoint that needs a token.
- Every amount in a model comes from a decimal string by a `numeric` cast; nothing in plan 2 scales by decimals, except the prefix sum (10^8) in a test.

## Review Focus

1. **A move linked to the wrong batch, or none.** Joining on the detail's `batch_number` (null until batched) or on time instead of the block range gives no batch or the wrong L1 hashes. Tests: `a_movement_takes_the_batch_whose_range_holds_its_block` (Task 4); `lighter_batches_are_contiguous` (Task 3).
2. **A batch frozen before it settles.** A batch read while `committed` and never read again keeps no execute hash. Test: `a batch not yet final is read again next run, and the checkpoint stops before it` (Task 3).
3. **A filter that drops types without an error.** A repeated `pub_data_type` keeps only the first type. Test: `accountLogs asks for every ledger type in one comma-separated pub_data_type, never Trade` (Task 2).
4. **A walk over a growing list.** New entries push old ones onto the next page; an Explorer that ignored `offset` would loop forever. Tests: `an entry pushed onto the next page is written once`, `a page that repeats the previous one fails the walk` (Task 4).
5. **An open point saved as final.** `pnl`'s last point sits at the request time and `stats/tx` ends with the current hour. Tests: `the point at the request time waits for the next run` (Task 6), `the current hour waits for the next run` (Task 7).

## Files

```
catalog/vendors/lighter/{vendor.yaml,NOTES.md}                                   Task 1 (modify)
ingestion/lib/src/lighter/{explorer.ts,explorer.test.ts,accounts.ts,accounts.test.ts}   Task 2
ingestion/sources/lighter-{batches,account-logs,accounts,pnl,tx-stats,assets,system-config,public-pools}/
    package.json .env.example src/{source.ts,index.ts,source.test.ts} [addresses.json]
transformation/models/staging/lighter/stg_lighter__<table>.sql, stg_lighter__account_log_details.sql
transformation/models/intermediate/lighter/int_lighter_{batches,account_movements,account_position_snapshots,
    account_asset_snapshots,funding_payments,account_ledger}.sql
transformation/models/marts/lighter/lighter_<mart>.sql
transformation/tests/lighter_{batches_are_contiguous,movements_match_detail_batch,account_flows_match_pnl,
    funding_prefix_steps_match_rates,positions_match_snapshots,ledger_matches_collateral}.sql
Modified: ingestion/lib/src/lighter/index.ts, ingestion/sources.json, ingestion/pnpm-lock.yaml,
          the lighter _sources.yml and _models.yml files, README.md, docs/architecture.md
```

---

### Task 1: Catalog plan 2's endpoints and prove the open facts

**Files:**
- Modify: `catalog/vendors/lighter/vendor.yaml`, `catalog/vendors/lighter/NOTES.md`

**Interfaces:**
- Consumes: plan 1's catalog and, for P21, plan 1's `lighter_funding_rates` and `lighter_account_fills`.
- Produces: the NOTES sections and proof rows that Tasks 2 to 9 cite; the answers to P18 to P21, which Tasks 4 and 9 need.

- [ ] **Step 1: Update `vendor.yaml`.** Add the eight packages to `sources`, each endpoint of Decision 1 to `endpoints` (`use: source` or `use: proof`), the Explorer weights and error shapes to `limits` and `errors`, and set each `inventory` entry's `plan` to match Decision 1, with the reason for each `out`.
- [ ] **Step 2: Rewrite NOTES' *For plan 2*** as five sections: *Explorer* (coverage from batch 28910, weights, errors, the comma-only filter), *Batches and L1 settlement* (ranges, sizes, statuses, commit lag, shared execute txs), *Account logs* (shapes, units as decimal strings, the `quote` exception, hashes per fill, `logs/{hash}`), *Account value* (`pnl` fields, the perps-value identity, the flow mapping, the 1h cap), *Funding prefix sums*. Then proof rows, each with the `curl … | jq` command that rebuilds it:
  - P11 first batch: `batches/28910` answers with first block 41849406 at 2025-08-25T15:28:03.691073Z; `batches/28909` answers 404.
  - P12 contiguity: the ranges of 270062, 270063 and 270064; batch 109274 holds 427 blocks.
  - P13 the comma filter on account 1000 (repeated: 9 entries, all `L1Deposit`; comma: 10, with the `WithdrawV2`).
  - P14 the perps-value identity on account 1000 (idle since 2025-12-30, so it reruns the same): last `1d` point gives 0.608697, equal to `account` `collateral`.
  - P15 the flow mapping on accounts 20000 and 1000, with the values in *What we know*.
  - P16 the settlement link: `logs/00000000001782c02e…` → block 137652420 → `batches/109274` → execute `0x23a3d85c…` at 2025-12-30T11:33:23Z.
  - P17 the `1h` cap: 7 days answer, 10 days give 22403. Bisect 8 and 9 days and record the largest that answers.
- [ ] **Step 3: Prove the four open facts and add their rows.**
  - P18: bisect by day the oldest 693073 or 313004 hash that `tx?by=hash` still finds. Record the day count; plan 2 does not depend on it.
  - P19: walk `accounts/313004/logs` with `LEDGER_TYPES` from now back to 2026-11-14 (about 50 pages; keep the Explorer under 45 weight a minute). `count(*) = count(distinct hash)` must hold. If it fails, stop: Task 4's key needs the repeated entries' difference added.
  - P20: for every `DETAIL_TYPES` entry of 313004 and 693073 since 2026-11-16, read `logs/{hash}` and its batch: every deposit and withdrawal sits in an `executed` batch. Record any `nothing_to_execute` batch that holds one; that would overturn *Batches*' reading of the status.
  - P21: read `account` of a pool with an open ETH position (281474976710653, "ETH 3x long", or any account whose ETH position does not trade in the hour) at about HH:59:30 and HH:00:30. With no fill between (check its Explorer log), the collateral change must be `−position × value` for direction `long` and `+position × value` for `short`, `position` signed long-positive, `value` the `fundings` value at HH:00. Write the sign that held. Task 9 uses it; if neither held, Task 9 leaves funding out (its Step 4 says how).
- [ ] **Step 4: Verify.** Rerun each proof row's command; each prints the value in the table.
- [ ] **Step 5: Commit.**

```bash
git add catalog/vendors/lighter
git commit -m "Catalog Lighter's Explorer, batches and account endpoints for plan 2"
```

### Task 2: The Explorer client and the account resolver

**Files:**
- Create: `ingestion/lib/src/lighter/explorer.ts`, `ingestion/lib/src/lighter/accounts.ts`
- Test: `ingestion/lib/src/lighter/explorer.test.ts`, `ingestion/lib/src/lighter/accounts.test.ts`
- Modify: `ingestion/lib/src/lighter/index.ts` (re-export both)

**Interfaces:**
- Consumes: `Clock`, `systemClock`, `LighterClient`, `LighterError` (plan 1, Task 2); `observedFetch` and `observeDelay` from `@ingestion/lib`.
- Produces, from `@ingestion/lib/lighter`:

```ts
export const lighterExplorerEnv: z.ZodObject<{
  LIGHTER_EXPLORER_URL: /* z.url().default("https://explorer.elliot.ai") */;
  LIGHTER_EXPLORER_WEIGHT_PER_MINUTE: /* z.coerce.number().int().positive().max(45).default(15) */;
}>;
export type LighterExplorerEnv = z.infer<typeof lighterExplorerEnv>;
/** The docs' PubDataType enum but Empty and Trade, in the docs' order (39 values). */
export const LEDGER_TYPES: readonly string[];
/** L1Deposit(V2), Withdraw(V2), L2Transfer(V2), L2UpdateMargin, L2MintShares, BurnedShares,
 *  L2StakeAssets, UnstakeAssets, ExecutedPendingUnlock, ExitPosition(WithFunding). */
export const DETAIL_TYPES: readonly string[];
export type ExplorerLog = { hash: string; time: string; tx_type: string; pubdata_type: string;
  status: string | null; pubdata: Record<string, unknown> } & Record<string, unknown>;
export class ExplorerError extends Error { readonly status: number; get retryable(): boolean }
export type ExplorerClient = {
  get(path: string, query?: Record<string, string | number>, weight?: number): Promise<unknown>;
  recentBatches(): Promise<Record<string, unknown>[]>;                       // weight 1
  batch(batchNumber: number): Promise<Record<string, unknown> | undefined>;  // weight 1; undefined on 404
  accountLogs(accountIndex: number, page: { limit: number; offset: number }): Promise<ExplorerLog[]>; // weight 4
  log(hash: string): Promise<Record<string, unknown>>;                        // weight 1
  txStats(): Promise<Record<string, unknown>>;                                // weight 1
};
export function createExplorerClient(env: LighterExplorerEnv, clock?: Clock): ExplorerClient;

export type AccountsFile = { accounts?: number[]; l1_addresses?: string[] };
export const accountsFileSchema: z.ZodType<AccountsFile>;
/** Listed indexes plus every sub-account of each listed L1 address, sorted, without repeats. */
export function resolveAccounts(client: LighterClient, file: AccountsFile): Promise<number[]>;
```

- [ ] **Step 1: Write the failing tests.** A `node:http` fake serves `/api/batches`, `/api/batches/{n}`, `/api/accounts/{n}/logs`, `/api/logs/{hash}` and `/api/stats/tx`, records each request's path and query, and lets a test script replies. A second fake serves `/api/v1/accountsByL1Address`.

```ts
test("paces requests by weight: a weight-4 page, then two weight-1 reads at 15 a minute", async (t) => {
  await explorer.accountLogs(313004, { limit: 100, offset: 0 });
  await explorer.batch(270063);
  await explorer.batch(270064);
  assert.deepEqual(clock.sleeps, [16000, 4000]);
});
test("accountLogs asks for every ledger type in one comma-separated pub_data_type, never Trade", async (t) => {
  await explorer.accountLogs(1000, { limit: 100, offset: 200 });
  const q = requests[0].query;
  assert.equal(q.getAll("pub_data_type").length, 1);
  assert.deepEqual(q.get("pub_data_type")!.split(","), [...LEDGER_TYPES]);
  assert.equal(LEDGER_TYPES.includes("Trade"), false);
  assert.equal(LEDGER_TYPES.includes("TradeWithFunding"), true);
  assert.deepEqual([q.get("limit"), q.get("offset")], ["100", "200"]);
});
test("a 404 batch reads as undefined; a 404 log fails, quoting the error", async (t) => {
  assert.equal(await explorer.batch(28909), undefined);        // {"error":"batch=28909 not found with block=0"}
  await assert.rejects(explorer.log("deadbeef"), /HTTP 404 .*log deadbeef not found/);
});
test("a 400 fails at once, quoting the Explorer's error", async (t) => {
  await assert.rejects(explorer.get("/api/accounts/1/logs", { pub_data_type: "Nope" }, 4), /invalid pubDataType=Nope/);
  assert.equal(requests.length, 1);
});
test("a 429 waits and is sent again", async (t) => { /* 429, then 200 [] → [] and a 2000 ms sleep */ });
test("lighterExplorerEnv defaults the Explorer URL and 15 a minute, and refuses more than 45", () => {});
test("resolveAccounts keeps listed indexes and adds every sub-account of each L1 address, sorted and unique", async (t) => {
  // 0x948b… has sub_accounts [1000]; file { accounts: [313004, 1000], l1_addresses: ["0x948b…"] }
  assert.deepEqual(await resolveAccounts(client, file), [1000, 313004]);
});
test("an L1 address Lighter does not know fails the run, naming it", async (t) => {
  // 400 {"code":21100,"message":"account not found"}
  await assert.rejects(resolveAccounts(client, { l1_addresses: ["0x1111111111111111111111111111111111111111"] }),
    /addresses\.json lists 0x1111111111111111111111111111111111111111, but Lighter has no account for it/);
});
test("accountsFileSchema needs accounts or l1_addresses, each with at least one valid entry", () => {
  // {} → /lists no accounts and no l1_addresses/; {"accounts":[]} and {"accounts":[-1]} → name the key;
  // {"l1_addresses":["0x12"]} → names the key
});
```

- [ ] **Step 2: Run them to see them fail.** `cd ingestion/lib && mise exec -- pnpm exec tsx --test src/lighter/explorer.test.ts src/lighter/accounts.test.ts`. Expected: FAIL, cannot find `#src/lighter/explorer.ts`.
- [ ] **Step 3: Implement** `explorer.ts` in the shape of plan 1's `client.ts`: one request at a time, 60 s timeout, the pacing of Decision 6, retries on 429, 405, 5xx and network errors. Other statuses throw `ExplorerError` with the status and the body's `error`; `batch` turns a 404 into `undefined`. Paths are `/api/…` under `LIGHTER_EXPLORER_URL`. `accounts.ts`: account indexes are non-negative safe integers and L1 addresses match `/^0x[0-9a-fA-F]{40}$/`; `resolveAccounts` turns a `LighterError` with code 21100 into the message above.
- [ ] **Step 4: Run them to see them pass.** Same command, then `cd ingestion && mise exec -- pnpm typecheck`. Expected: PASS, no errors.
- [ ] **Step 5: Commit.**

```bash
git add ingestion/lib/src/lighter
git commit -m "Add a weight-paced Explorer client and an account resolver to @ingestion/lib/lighter"
```

### Task 3: L1 batches and `lighter_batches`

**Files:**
- Create: `ingestion/sources/lighter-batches/{package.json,.env.example,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__batches.sql`, `int_lighter_batches.sql`, `lighter_batches.sql`, `transformation/tests/lighter_batches_are_contiguous.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `ingestion/pnpm-lock.yaml`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: `createExplorerClient`, `lighterExplorerEnv` (Task 2); `historyKey`, `retryPages`, `uniqueBy` from `@ingestion/lib`.
- Produces: `BatchCall = { kind: "batch"; batch_number: number }`, id `batch:<n>`; records `{ id: "batch:<n>", callId: "batch:<n>", data: <reply> }`; checkpoint key `historyKey(["lighter", LIGHTER_EXPLORER_URL, "batches", START_TIME])`, value `{ origin: number; next: number }`; exported helpers `batchHolding(explorer: ExplorerClient, time: number, head: number): Promise<number>` and `isFinal(reply: Record<string, unknown>): boolean`; mart `lighter_batches` (`batch_number, first_block, last_block, block_count, tx_count, first_block_time, last_block_time, status, is_final, commit_tx_hash, committed_at, verify_tx_hash, verified_at, execute_tx_hash, executed_at, final_at, updated_at`), which Tasks 4 and 9 join on the block range.

The env is `lighterExplorerEnv.extend({ START_TIME })`, `START_TIME` an ISO datetime turned into ms as in `coinbase-candles`. A run reads the head (the highest `batch_number` in `/batches`), then `origin` from the checkpoint or `batchHolding(START_TIME)`: the highest batch whose first block's `updated_at` is at or before `START_TIME`, counting a 404 as before; when none is, the first batch that answers. It reads `next` (or `origin`) to the head in order, then retried batches below `next`. It yields every 10 batches with the checkpoint, whose `next` is the lowest batch read this run that is not final, or the highest read plus one. A failed batch, including one that answers 404 between `origin` and the head, becomes a dead letter and does not hold `next` back.

- [ ] **Step 1: Write the failing tests.** The fake serves batches 100 to 200 (404 below 120), each with 10 blocks; batch `n` starts at block `10n` at time `T0 + n` minutes.

```ts
test("starts at the batch holding START_TIME, found by bisection, counting a 404 as before", async (t) => {
  // START_TIME = T0 + 150.5 min → origin 150, at most 8 batch reads before the walk
});
test("START_TIME before the first batch served starts at that batch", async (t) => { /* START_TIME = T0 → 120 */ });
test("reads from the checkpoint to the head and keeps each reply as sent, keyed by batch number", async (t) => {
  // saved { origin: 150, next: 198 }, head 200 → ids batch:198, batch:199, batch:200; data deepEqual the replies
});
test("a batch not yet final is read again next run, and the checkpoint stops before it", async (t) => {
  // 198 executed, 199 committed, 200 nothing_to_execute → checkpoint { origin: 150, next: 199 }
  // second run, 199 now verified then executed → reads 199 and 200 again; next 201
});
test("a failed batch waits as a dead letter, and the batches after it still load", async (t) => {});
test("a retried batch is read once even when the walk also covers it", async (t) => {});
```

- [ ] **Step 2: Run them to see them fail.** `cd ingestion/sources/lighter-batches && mise exec -- pnpm test`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement the source**, then run `cd ingestion && mise exec -- pnpm install && mise exec -- pnpm generate-sources`. `.env.example` sets `START_TIME=2026-11-16T00:00:00Z` and `LIGHTER_EXPLORER_WEIGHT_PER_MINUTE=25`.
- [ ] **Step 4: Write the failing dbt unit tests** on `int_lighter_batches`:
  - `l1_times_come_from_status_changes`: batch 270062 (committed 11:54:23, verified 12:08:59, executed 12:08:59) gives those three times, status `executed`, `is_final` true. Batch 270064 (committed 11:56:59; `nothing_to_execute` 12:14:35 with the verify hash) gives `verified_at` 12:14:35, `executed_at` null, status `nothing_to_execute`, `is_final` true, `final_at` 12:14:35.
  - `a_new_batch_is_pending`: batch 270105 with `batch_details` `{}` and no status changes gives status `pending`, `is_final` false.
  - `block_range_and_counts_come_from_the_block_list`: three blocks 391216830 (500 txs), 391216831 (477), 391216832 (500) give `first_block` 391216830, `last_block` 391216832, `block_count` 3, `tx_count` 1477, `first_block_time` 2026-11-17 11:46:13.256136+00.

  Run `cd transformation && ../orchestration/.venv/bin/dbt test --select int_lighter_batches,test_type:unit` with `.env` loaded. Expected: FAIL, the model does not exist.
- [ ] **Step 5: Add the models.** Staging casts `batch_number`, `updated_at`, the three hashes, and keeps `blocks` and `status_changes` as jsonb. `int_lighter_batches` reads the first and last block and sums `total_transactions`; `verified_at` is the change whose `hash` is `verify_tx_hash`; status is the latest change's, or `pending`. The mart is a table with tests `unique` and `not_null` on `batch_number` and `accepted_values` `[pending, committed, verified, executed, nothing_to_execute]` on `status`. `lighter_batches_are_contiguous` (error) lists any batch whose `block_count <> last_block − first_block + 1`, and any pair of loaded consecutive batches where `first_block <> previous last_block + 1`.
- [ ] **Step 6: Run the unit tests to see them pass.** Same command. Expected: PASS.
- [ ] **Step 7: Document.** README section for `lighter_batches`; the source paragraph and its `pnpm ingest` line in `docs/architecture.md`, saying that Explorer history starts at 2025-08-25 and that a day is about 830 batches.
- [ ] **Step 8: Verify.** Package tests, `pnpm typecheck` and `cd orchestration && uv run pytest` pass. `LIGHTER_EXPLORER_WEIGHT_PER_MINUTE=45 uv run --project orchestration bj run lighter --select lighter/batches lighter_batches` (about half an hour) starts at batch 268824 and reaches the head; `lighter_batches_are_contiguous` passes; batch 269235 has `first_block` 389892030, `last_block` 389893629, `execute_tx_hash` `0x0fc6217eaf0f0b2fc9e310ce8890d90dd7e37b8a97a848b289adccdc2b8bb5e2` and `executed_at` 2026-11-16 18:08:47+00. A second run reads only the batches from the first one not final.
- [ ] **Step 9: Commit** (`git commit -m "Load Lighter's L1 batches into lighter_batches with their block ranges and L1 hashes"`).

### Task 4: Account logs and `lighter_account_movements`

**Files:**
- Create: `ingestion/sources/lighter-account-logs/{package.json,.env.example,addresses.json,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__account_logs.sql`, `stg_lighter__account_log_details.sql`, `int_lighter_account_movements.sql`, `lighter_account_movements.sql`, `transformation/tests/lighter_movements_match_detail_batch.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `ingestion/pnpm-lock.yaml`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: Task 2's Explorer client, `LEDGER_TYPES`, `DETAIL_TYPES`, `accountsFileSchema`, `resolveAccounts`; plan 1's `createLighterClient`, `lighterEnv`; `int_lighter_batches` (Task 3).
- Produces:
  - Calls: `{ kind: "walk"; account_index: number; since: number }`, id `walk:<account_index>`; `{ kind: "detail"; hash: string }`, id `detail:<hash>`. The `call` schema is their discriminated union.
  - Records: `{ id: "log:<account_index>:<hash>", data: { account_index, entry } }` (`entry` as sent), whose `callId` is `walk:<account_index>` on the walk's last page and `walk:<account_index>#<page>` before it; `{ id: "detail:<hash>", callId: "detail:<hash>", data: <logs/{hash} reply> }`.
  - Checkpoint per account: key `historyKey(["lighter", LIGHTER_EXPLORER_URL, "account_logs", account_index, START_TIME, LEDGER_TYPES])`, value `{ account_index, origin: START_TIME, newest, read_at }` (ms). Task 6's flow test reads it from `raw."_checkpoints"` as the account's loaded window `[origin, read_at]`.
  - `int_lighter_account_movements` and mart `lighter_account_movements`: `id, hash, log_time, account_index, leg, kind, asset, route, amount, signed_amount, counterparty_account_index, l1_address, pubdata_type, tx_type, block_number, batch_number, detail_batch_number, batch_status, is_final, commit_tx_hash, committed_at, verify_tx_hash, verified_at, execute_tx_hash, executed_at, final_at`.

The env is `lighterExplorerEnv.extend(lighterEnv.shape).extend({ START_TIME, HISTORY_OVERLAP_DAYS: z.coerce.number().int().nonnegative().default(1), LIGHTER_LOG_PAGE_SIZE: z.coerce.number().int().positive().max(100).default(100) })`. A walk reads pages from offset 0 until a page is shorter than the page size or holds an entry older than `since`; it writes the entries at or after `since`. `since` is `newest − HISTORY_OVERLAP_DAYS` days from the checkpoint, or `START_TIME`. A retried walk for an account with a fresh walk merges into it with the earlier `since`. After each page, the source reads `logs/{hash}` for the page's `DETAIL_TYPES` entries, one detail call each. `newest` is the time of the first entry on page 0, and `read_at` the time page 0 was asked for; both go out with the walk's last page.

- [ ] **Step 1: Write the failing source tests.** The fake Explorer pages a list newest first and can insert entries at the head between pages.

```ts
test("walks pages newest first by offset until an entry older than since, and keeps none older", async (t) => {
  // 250 entries one minute apart, since = the 180th → offsets 0, 100; 180 records
});
test("an entry pushed onto the next page is written once", async (t) => {
  // two new entries arrive after page 0 → page 1 repeats two entries; record ids are unique across the run
});
test("a page that repeats the previous one fails the walk", async (t) => { /* failed[0].id "walk:313004", /repeated/ */ });
test("reads logs/{hash} for detail types only", async (t) => {
  // page holds L1DepositV2, TradeWithFunding, L2TransferV2, L2UpdateLeverage → details for the deposit and transfer
});
test("a failed page fails its walk as a dead letter; pages before it stay, and only the last page clears it", async (t) => {
  assert.deepEqual(batches.map((b) => [...new Set(b.records.map((r) => r.callId))]), [["walk:313004#0"]]);
  assert.equal(batches.at(-1)!.failed[0].id, "walk:313004");
});
test("the next run walks back to the newest entry it saw, less the overlap", async (t) => {});
test("a failed detail waits as its own dead letter", async (t) => { /* failed[0].id "detail:<hash>" */ });
test("an L1 address in addresses.json walks each of its sub-accounts", async (t) => {});
test("a transfer between two listed accounts is written under each account", async (t) => {
  // ids log:1000:e7a0… and log:675395:e7a0…
});
```

- [ ] **Step 2: Run them to see them fail.** `cd ingestion/sources/lighter-account-logs && mise exec -- pnpm test`. Expected: FAIL.
- [ ] **Step 3: Implement the source**, then `pnpm install` and `pnpm generate-sources`. Ship `addresses.json` as `{ "accounts": [313004, 693073] }`; `.env.example` sets `START_TIME=2026-11-16T00:00:00Z` and `LIGHTER_EXPLORER_WEIGHT_PER_MINUTE=15`.
- [ ] **Step 4: Write the failing dbt unit tests** on `int_lighter_account_movements`. It makes one row per leg that belongs to the queried account (`data.account_index`), by these rules (NOTES, *Account logs* and *Account value*):

  | `pubdata_type` | Legs: account, `kind`, asset, route, `signed_amount` |
  |---|---|
  | `L1Deposit` | `account_index`: `deposit`, USDC, perps, `+usdc_amount` |
  | `L1DepositV2` | `account_index`: `deposit`, `asset_index`, `lower(route_type)`, `+accepted_amount` |
  | `Withdraw` / `WithdrawV2` | `from_account_index`: `withdrawal`, USDC / `asset_index`, perps / route, `−usdc_amount` / `−amount` |
  | `L2Transfer` | from: `transfer_out`, USDC, perps, `−usdc_amount`; to: `transfer_in`, `+usdc_amount` |
  | `L2TransferV2`, from ≠ to | from: `transfer_out`, asset, from route, `−amount`, and `transfer_fee`, USDC, from route, `−usdc_fee` when it is above 0; to: `transfer_in`, asset, to route, `+amount` |
  | `L2TransferV2`, from = to | `route_move`: leg `from` on the from route, `−amount`; leg `to` on the to route, `+amount` |
  | `L2MintShares` / `BurnedShares` | `pool_mint`, USDC, perps, `−usdc_amount` / `pool_burn`, `+shares_to_burn_usdc`; counterparty the pool |
  | `L2StakeAssets`, `UnstakeAssets`, `ExecutedPendingUnlock`, `L2UpdateMargin` | `stake`, `unstake`, `unlock`, `margin_move`, with `amount` as sent and `signed_amount` null |

  `leg` is `from`, `to` or `fee` for transfers and route moves, `self` for the rest; `id` is `<hash>:<account>:<leg>`. The batch comes from `int_lighter_batches` on the detail's `block_number between first_block and last_block`, never from `detail_batch_number`.
  - `a_v1_deposit_is_usdc_on_perps`: 313004's `L1Deposit` of 35.000000 (`00000000000cc7191f…`) gives one leg, `deposit`, USDC, perps, +35.
  - `a_v2_transfer_with_a_fee_gives_the_sender_two_legs`: 20000 → 675395, amount 1900.900000, `usdc_fee` 3.000000, queried as 20000, gives `transfer_out` −1900.9 and `transfer_fee` −3, counterparty 675395; queried as 675395, one `transfer_in` +1900.9.
  - `a_route_move_gives_two_legs_on_one_account`: 1000's SPOT → PERPS move of 104508.600000 (`e7a0a2bb…`) gives USDC spot −104508.6 and USDC perps +104508.6, both `route_move`.
  - `a_movement_takes_the_batch_whose_range_holds_its_block`: 1000's `L1Withdraw` (`00000000001782c02e…`, block 137652420) with batches 109273 (ending at 137652411) and 109274 (137652412–137652838) gives batch 109274, `execute_tx_hash` `0x23a3d85cc05e63342464cf05cf14df49ca4701089ed1779f06ceac577cba32fe`, `executed_at` 2025-12-30 11:33:23+00.

  Run `dbt test --select int_lighter_account_movements,test_type:unit`. Expected: FAIL.
- [ ] **Step 5: Add the models.** `stg_lighter__account_logs` reads `log:` records: `account_index`, `hash`, `tx_type`, `pubdata_type`, `log_time` (from `time`), `status`, `pubdata` (the inner object, jsonb). `stg_lighter__account_log_details` reads `detail:` records: `hash`, `block_number`, `batch_number`, `status`. The mart selects the intermediate model; tests: `unique` and `not_null` on `id`; `not_null` on `hash`, `account_index`, `kind`, `log_time`; `accepted_values` on `kind` and on `route` (`perps, spot`). `lighter_movements_match_detail_batch` (warn) lists rows whose `detail_batch_number` is set and differs from `batch_number`, and rows with a block but no batch while a loaded batch ends after that block.
- [ ] **Step 6: Run the unit tests to see them pass.** Expected: PASS.
- [ ] **Step 7: Document.** README section for `lighter_account_movements`, saying which statuses settle on Ethereum and that a transfer to the fast-withdraw pool is the user's side of a fast withdrawal; source paragraph and `pnpm ingest` line in `docs/architecture.md`.
- [ ] **Step 8: Verify.** Package tests, typecheck and pytest pass. After Task 3's run, `bj run lighter --select lighter/account_logs lighter_account_movements` loads 693073's five deposits of 2026-11-16 and its transfers. Deposit `00000000001e5aa83d00000130000000000000000000000000000000000000000000000000000000` has `block_number` 389893328, `batch_number` 269235, `execute_tx_hash` `0x0fc6217e…` and `executed_at` 2026-11-16 18:08:47+00. `lighter_movements_match_detail_batch` reports nothing.
- [ ] **Step 9: Commit** (`git commit -m "Load Lighter account logs and link each money move to its L1 batch in lighter_account_movements"`).

### Task 5: Account snapshots

**Files:**
- Create: `ingestion/sources/lighter-accounts/{package.json,.env.example,addresses.json,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__accounts.sql`, `int_lighter_account_position_snapshots.sql`, `int_lighter_account_asset_snapshots.sql`, `lighter_account_snapshots.sql`, `lighter_account_position_snapshots.sql`, `lighter_account_asset_snapshots.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: plan 1's client and `lighterEnv`; Task 2's `accountsFileSchema`, `resolveAccounts`.
- Produces: call `{ kind: "account"; account_index: number }`, id `account:<index>`; records `{ id: "<account_index>:<read_at>", callId: "account:<index>", data: { read_at, account } }`, `account` being `accounts[0]` as sent. Marts:
  - `lighter_account_snapshots`: `id, account_index, read_at, l1_address, account_type, status, collateral, available_balance, total_asset_value, cross_asset_value, cross_initial_margin_requirement, cross_maintenance_margin_requirement, transaction_time`.
  - `lighter_account_position_snapshots`: `id` (`<account>:<market>:<read_at>`), `account_index, read_at, market_id, symbol, position` (signed: `sign × position`), `avg_entry_price, position_value, unrealized_pnl, realized_pnl, total_funding_paid_out, liquidation_price, margin_mode, allocated_margin, initial_margin_fraction`.
  - `lighter_account_asset_snapshots`: `id` (`<account>:<asset_id>:<read_at>`), `account_index, read_at, asset_id, symbol, balance, locked_balance, margin_balance, margin_mode`.

`read_at` is `clock.now()` at the start of `extract`. A retried read is made once, by the run's own call, as for plan 1's markets.

- [ ] **Step 1: Write the failing tests:** `each run reads every listed account once, keyed by account and read time`; `a retried read is made once, by the run's own call`; `an account Lighter does not know waits as a dead letter, quoting 29404`; `an L1 address reads each of its sub-accounts`.
- [ ] **Step 2: Run them to see them fail**, then **Step 3: implement** the source, and run `pnpm install` and `pnpm generate-sources`.
- [ ] **Step 4: Write the failing unit tests**: `position_is_signed_by_sign` (313004's ETH, sign −1, position 1.2821 → −1.2821; BTC, sign 1, 0.00000 → 0); `transaction_time_is_microseconds` (1794917810524549 → 2026-11-17 12:16:50.524549+00); `assets_explode_one_row_each` (313004's LIT and USDC → two rows, USDC `margin_balance` 97972.003001669667). Then add the models. Staging casts the account fields and keeps `positions`, `assets`, `shares` and `pending_unlocks` as jsonb; the two intermediate models explode them. Mart tests: `unique` and `not_null` on each `id`; `not_null` on `collateral` and `read_at`.
- [ ] **Step 5: Run them to see them pass**, document, verify (`bj run lighter --select lighter/accounts lighter_account_snapshots+`: two snapshot rows per run, and 313004's `total_asset_value` matches a fresh `account` read within the minute) and **commit** (`git commit -m "Read Lighter account snapshots into position and asset snapshot marts"`).

### Task 6: Account value history and the flow check

**Files:**
- Create: `ingestion/sources/lighter-pnl/{package.json,.env.example,addresses.json,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__pnl.sql`, `lighter_account_value_history.sql`, `transformation/tests/lighter_account_flows_match_pnl.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: plan 1's client; Task 2's account resolver; `lighter_account_movements` (Task 4) and its checkpoints in `raw."_checkpoints"`.
- Produces: call `{ kind: "pnl"; account_index: number; resolution: "1d" | "1h" }`, id `pnl:<account>:<resolution>`; records `{ id: "<account>:<resolution>:<timestamp>", data: { account_index, resolution, point } }`; mart `lighter_account_value_history` (`id, account_index, resolution, point_time, perps_value, trade_pnl, trade_spot_pnl, inflow, outflow, spot_inflow, spot_outflow, pool_pnl, pool_inflow, pool_outflow, staking_pnl, staking_inflow, staking_outflow, pool_total_shares, volume`), with `perps_value = inflow − outflow + trade_pnl`.

The env is `lighterEnv.extend({ START_TIME })`. Per account a run sends two calls: `1d` from `START_TIME` floored to the UTC day to now, and `1h` from the later of `START_TIME` and now − 7 days to now, both in seconds with `count_back=0`. It keeps points whose `timestamp` is a multiple of 86400 (`1d`) or 3600 (`1h`).

- [ ] **Step 1: Write the failing tests:**

```ts
test("reads each account's 1d series from START_TIME and its last 7 days of 1h", async (t) => {
  // now 2026-11-17T13:24:32Z, START_TIME 2026-11-10 → 1d start 1794268800; 1h start 1794317072 (now − 7 d)
});
test("the point at the request time waits for the next run", async (t) => {
  // 1d reply ends with timestamp 1794921499 → not loaded; 1794873600 (midnight) is
});
test("a 22403 for an over-long hourly range fails the call, quoting it", async (t) => {});
test("a failed call waits as a dead letter, and the account's other series loads", async (t) => {});
```

- [ ] **Step 2: Run them to see them fail**, then **Step 3: implement**, and run `pnpm install` and `pnpm generate-sources`. `.env.example` sets `START_TIME=2026-11-10T00:00:00Z`.
- [ ] **Step 4: Write the failing unit test** `perps_value_is_inflow_less_outflow_plus_trade_pnl`: account 1000's point (inflow 156508.908444, outflow 153478.114476, trade_pnl −3030.185271) gives 0.608697. Add staging (casts each field as numeric, `point_time` from seconds) and the mart; tests `unique` on `id`, `accepted_values` `[1d, 1h]` on `resolution`.
- [ ] **Step 5: Add `lighter_account_flows_match_pnl`** (warn). Per listed account and UTC day D whose whole span lies in the account's loaded window (from its `raw."_checkpoints"` row where `source_table = 'lighter_account_logs'`), and with `1d` points at D and D + 1 day: the change in `inflow` must equal the sum of positive USDC perps `signed_amount` in `lighter_account_movements` that day, and the change in `outflow` the sum of negative ones, negated; likewise `spot_inflow` and `spot_outflow` for USDC spot. It lists the account, day, field, the change and the sum when they differ by more than 0.000001. The mapping is NOTES' P15.
- [ ] **Step 6: Run the unit test and the flow check to see them pass**, document, verify (`bj run lighter --select lighter/pnl lighter_account_value_history lighter_account_flows_match_pnl`: 693073's deposits of 2026-11-16 account for its `inflow` change into 2026-11-17, and the check reports nothing) and **commit** (`git commit -m "Load Lighter account value history and check movements against its daily flows"`).

### Task 7: Hourly tx counts

**Files:**
- Create: `ingestion/sources/lighter-tx-stats/{package.json,.env.example,src/source.ts,src/index.ts,src/source.test.ts}`, `stg_lighter__tx_stats.sql`, `lighter_tx_stats.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Produces: call `{ kind: "tx_stats" }`, id `tx_stats`; records `{ id: "<timestamp>", data: { types, point } }` (`types` and one `data` row as sent); mart `lighter_tx_stats` (`hour, tx_count, uops_count`).

Each run reads the whole series again. The source fails the call when `types` is not `["timestamp","count","uopsCount"]`, so staging can read by position.

- [ ] **Step 1: Write the failing tests:** `writes one record per hour, keyed by its timestamp`; `the current hour waits for the next run` (a point with `timestamp + 3600` after the request time is dropped); `a changed types list fails the call, naming it`.
- [ ] **Step 2: Run them to see them fail**, **Step 3: implement**, `pnpm install`, `pnpm generate-sources`; `.env.example` sets `LIGHTER_EXPLORER_WEIGHT_PER_MINUTE=5`.
- [ ] **Step 4: Add the models** (staging: `hour` from seconds, two bigint counts; mart tests `unique` and `not_null` on `hour`), document, verify (`bj run lighter --select lighter/tx_stats lighter_tx_stats`: about 9,900 rows from 2025-10-02 00:00 UTC, one per hour with no gap) and **commit** (`git commit -m "Load Lighter's hourly tx counts into lighter_tx_stats"`).

### Task 8: Assets, system accounts and public pools

**Files:**
- Create: `ingestion/sources/lighter-{assets,system-config,public-pools}/{package.json,.env.example,src/source.ts,src/index.ts,src/source.test.ts}`
- Create: `stg_lighter__{assets,system_config,public_pools}.sql`, `lighter_assets.sql`, `lighter_system_accounts.sql`, `lighter_public_pools.sql`
- Modify: the lighter yml files, `ingestion/sources.json`, `README.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: plan 1's client and `lighterEnv`.
- Produces:
  - `lighter-assets`: call `{ kind: "asset_details" }`; records `{ id: "<asset_id>:<read_at>", data: { read_at, asset } }`; mart `lighter_assets`, the latest reading per `asset_id` (`asset_id, symbol, decimals, l1_decimals, l1_address, margin_mode, min_transfer_amount, min_withdrawal_amount, loan_to_value, liquidation_threshold, global_supply_cap, user_supply_cap, index_price, read_at`).
  - `lighter-system-config`: call `{ kind: "system_config" }`; record `{ id: "<read_at>", data: { read_at, config } }`; mart `lighter_system_accounts`, one row per role from the latest reading (`role` in `liquidity_pool, staking_pool, funding_fee_rebate, market_maker_incentive, fee_collector`, `account_index`, `read_at`).
  - `lighter-public-pools`: call `{ kind: "public_pools" }`, which walks `filter=all&limit=100` from `index=281474976710655`, the next `index` being the page's last `account_index − 1`, until a page is short; records `{ id: "<account_index>:<read_at>", data: { read_at, pool } }`, the last page's records carrying the call id as in Task 4; mart `lighter_public_pools` (`id, account_index, read_at, name, account_type, master_account_index, operator_fee, annual_percentage_yield, total_asset_value, total_spot_value, total_perps_value, total_shares, status, created_at`).

- [ ] **Step 1: Write the failing tests:** for assets, `each run reads every asset once, keyed by asset and read time`; for system config, `each run writes one reading`; for pools, `walks pages down from the top index until a short page` (pages of 100 and 37 → indexes asked 281474976710655 and the first page's last − 1) and `a failed page fails the walk, and pages before it stay`.
- [ ] **Step 2: Run them to see them fail**, **Step 3: implement** the three sources, `pnpm install`, `pnpm generate-sources`.
- [ ] **Step 4: Add the models** with tests: `unique` on each key; `accepted_values` on `role`; unit test `system_roles_unpivot_the_config` (the reply in *What we know* gives five rows, `liquidity_pool` 281474976710654).
- [ ] **Step 5: Document, verify** (`bj run lighter --select lighter/assets lighter/system_config lighter/public_pools lighter_assets lighter_system_accounts lighter_public_pools`: 13 assets with USDC `decimals` 6, five roles, and the LLP among the pools) **and commit** (`git commit -m "Load Lighter's assets, system accounts and public pools"`).

### Task 9: Funding, the account ledger and the reconciliations

**Files:**
- Create: `int_lighter_funding_payments.sql`, `int_lighter_account_ledger.sql`, `lighter_account_ledger.sql`
- Create: `transformation/tests/lighter_funding_prefix_steps_match_rates.sql`, `lighter_positions_match_snapshots.sql`, `lighter_ledger_matches_collateral.sql`
- Modify: the lighter yml files, `README.md`

**Interfaces:**
- Consumes: plan 1's `lighter_account_fills`, `lighter_trades`, `lighter_markets`, `lighter_funding_rates`; `lighter_account_movements`, `stg_lighter__account_logs` and `stg_lighter__account_log_details` (Task 4), `lighter_batches` (Task 3), `lighter_account_position_snapshots` and `lighter_account_snapshots` (Task 5).
- Produces: `int_lighter_funding_payments` (`account_index, market_id, funding_time, position, value_usdc_per_unit, direction, amount`) and mart `lighter_account_ledger` (`id, account_index, event_time, kind, asset, route, amount, cumulative_amount, market_id, position_after, trade_id, hash, block_number, batch_number, batch_status, execute_tx_hash, executed_at`).

A listed account is an `account_index` in `stg_lighter__account_logs`, so every model here keeps only those. `int_lighter_funding_payments` holds one row per listed account, market and funding hour while the account held a position: `position` is the `position_after` of the account's last fill in that market before `funding_time`, or the first fill's `position_before` for hours before it, from the first fill to the end of the last UTC day in `lighter_trades`. `amount = −position × value_usdc_per_unit` when `direction` is `long` and `+position × value_usdc_per_unit` when `short`, unless P21 proved the other sign. `int_lighter_account_ledger` stacks:
- `lighter_account_movements` rows with a `signed_amount` (`kind` as there, `id` `move:<movement id>`);
- perp fills of `lighter_account_fills` (`market_type = 'perp'` in `lighter_markets`): `kind` `fill`, USDC perps, `amount = realized_pnl − fee_usdc −` the role's integrator fee from `lighter_trades`, `position_after`, `trade_id`, and the trade's `block_number` joined to `lighter_batches` by range; `id` `fill:<fill id>`;
- `int_lighter_funding_payments`: `kind` `funding`, USDC perps; `id` `funding:<account>:<market>:<funding_time>`;
- `ExitPosition` and `ExitPositionWithFunding` entries: `kind` `exit_position`, `market_id`, `position_after` 0, `amount` null, the block from `stg_lighter__account_log_details` joined to `lighter_batches` by range; `id` `exit:<hash>:<account>`.

`cumulative_amount` sums `amount` per account, asset and route, ordered by `event_time` and `id`, from the start of what is loaded.

- [ ] **Step 1: Write the failing dbt unit tests:**
  - `funding_is_position_times_value_signed_by_direction` on `int_lighter_funding_payments`: ETH at 2026-11-17 13:00 (value 0.01641159, long) with a fill leaving the account long 0.7863 at 12:16 gives −0.012904433217; the same hour with a short of 1.2821 gives +0.021041299539.
  - `a_fill_moves_collateral_by_realized_pnl_less_fees` on `int_lighter_account_ledger`: a taker fill with `realized_pnl` −0.009548 and `fee_usdc` 0 gives `amount` −0.009548, `kind` fill.
  - `an_exit_zeroes_the_position`: an `ExitPosition` entry gives `position_after` 0.
  - `cumulative_amount_runs_per_account_asset_and_route`: deposit +35 then withdrawal −10 on USDC perps gives 35, then 25.

  Run `dbt test --select int_lighter_funding_payments int_lighter_account_ledger,test_type:unit`. Expected: FAIL.
- [ ] **Step 2: Implement the models and mart.** Mart tests: `unique` and `not_null` on `id`; `not_null` on `account_index`, `event_time`, `kind`; `accepted_values` on `kind`. If plan 1's P9 left pnl unscaled, fills carry `amount` null and the mart's description says so.
- [ ] **Step 3: Run them to see them pass.** Expected: PASS.
- [ ] **Step 4: Add the three warn tests.**
  - `lighter_funding_prefix_steps_match_rates`: per market, take the distinct `funding_rate_prefix_sum` values in `TradeWithFunding` entries, each with the first `log_time` it was seen; between consecutive values the step must equal the sum, over `lighter_funding_rates` hours in between, of `round(10^8 × value)`, positive for `long` and negative for `short`. On 2026-11-17 it covers ETH's step of 1,641,159 at 13:00.
  - `lighter_positions_match_snapshots`: for each position snapshot whose account has a ledger fill or exit after `read_at` (so the fills cover the reading), the snapshot's signed `position` must equal the `position_after` of the account's last ledger row in that market at or before `read_at`, or 0 when there is none.
  - `lighter_ledger_matches_collateral`: between consecutive snapshots of an account with no isolated margin (`margin_mode` 0 on every position) and no ledger row with a null `amount` between them, the `collateral` change must equal the sum of USDC perps `amount` in `(read_at₁, read_at₂]`, within 0.000002 per row summed. Create it only if P21 proved the funding sign and plan 1's P9 the pnl scale; otherwise leave it out and say why in the README.
- [ ] **Step 5: Run every lighter test.** `dbt build --select +lighter_account_ledger lighter_funding_prefix_steps_match_rates lighter_positions_match_snapshots lighter_ledger_matches_collateral`. Expected: PASS, with each warn test's count reported.
- [ ] **Step 6: Document.** README section for `lighter_account_ledger`: what each `kind` means, what has a null `amount` and why, which tests check it, and that history starts at 2025-08-25 for logs, at the first S3 day for fills and at the first snapshot for readings.
- [ ] **Step 7: Verify.** `bj run lighter` (the whole pipeline) succeeds. For 313004 on 2026-11-16, `lighter_account_ledger` has one `fill` row per fill in `lighter_account_fills` and one `funding` row per hour it held ETH; `lighter_funding_prefix_steps_match_rates` and `lighter_positions_match_snapshots` report nothing.
- [ ] **Step 8: Commit** (`git commit -m "Build lighter_account_ledger from movements, fills and funding, and check it against Lighter's readings"`).
