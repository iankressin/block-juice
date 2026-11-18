# Lighter: notes

These notes cover the hosts, endpoints and S3 files in `vendor.yaml`. Every limit, field and value below comes from the Lighter docs that `vendor.yaml` lists, or from replies of `mainnet.zklighter.elliot.ai`, `explorer.elliot.ai` and the public S3 bucket on 2026-11-17 and, for plan 2, 2026-11-18. Two proof tables at the end give the command that rebuilds each fact: plan 1's rows P1 to P16, and plan 2's rows L11 to L21.

Three answers that later tasks branch on:

- **Trade ids were unique across the two day files checked.** 4,484,699 rows over 2026-11-15 and 2026-11-16 hold 4,484,699 distinct ids (P8). Uniqueness across all files is not proven. Raw trades are keyed on the id, so a repeated id would merge two trades into one row.
- **`ask_account_pnl` and `bid_account_pnl` are USDC × 10^6.** On all 52 trades where the API sent a pnl, the API's value × 10^6 equals the S3 integer (P9). Scale pnl by 10^6.
- **`direction` follows the sign of the rate; that it names the paying side is inferred.** (a) Proven: `direction` is `long` exactly when the WebSocket's signed `funding_rate` is positive, on all 40 markets paid at 14:00 UTC (P10). (b) Documented: the funding page says a positive funding rate means longs pay shorts. (c) Inferred from (a) and (b): `direction` names the side that pays. No doc page ties the funding page's rule to the WebSocket field, or says what `direction` means.

## Hosts and limits

| Host | Use | Limit |
|---|---|---|
| `https://mainnet.zklighter.elliot.ai/api/v1/` | exchange API | 60 requests per rolling minute per IP and per L1 address for a standard caller |
| `https://explorer.elliot.ai/api/` | Explorer, plan 2 | 45 weight per rolling minute, burst 45 |
| `https://aws-public-blockchain.s3.amazonaws.com/v1.1/lighter/core/mainnet/` | S3 dataset, region us-east-2 | none stated |

- A standard caller is not weighted, but an endpoint gets at most 24,000 / weight calls a minute, so only endpoints that weigh over 400 get fewer than 60. `exchangeMetrics` weighs 120, `trades` 200, `recentTrades` 600 and most others 300. The plan-1 sources call nothing over 300.
- Over the limit: HTTP 429 or 405. A firewall block lasts 60 s; an API-server block lasts weight / (total weight / 60) s. No reply carries a count of requests used, so pace by the clock. None was provoked here.
- Explorer weights: account logs 4, `blocks/{n}` 5, search 3, account positions 2, others 1.
- A success is HTTP 200 with `"code":200` in the body. Errors are HTTP 400 with a code: `{"code":20001,"message":"invalid param "}` (bad resolution, `limit=101`, unknown metric kind), `{"code":22400,"message":"invalid timestamps: end_timestamp must be greater than start_timestamp"}`, and `{"code":21619,"message":"invalid market type"}` from `fundings` for an id with no funding. Some 20001 replies add a reason after `invalid param : `.
- `/api/v1/blocks`, `/txs`, `/accountTxs`, `/currentHeight` and `/api/v1/status` answer HTTP 403 from CloudFront. They are retired.
- CloudFront fronts the API, and a reply can come from its cache: `orderBookDetails` came back with `X-Cache: Hit from cloudfront` and `Age: 1`.
- S3 needs no account. Anonymous HTTPS GET and ListObjectsV2 (`?list-type=2&prefix=…`) work. DuckDB reads the HTTPS URL as is, and `s3://` globs after `SET s3_region = 'us-east-2'`.

## Market identity

- The API's `market_id` is the public market id. `orderBookDetails` listed 257 markets at 13:29 UTC: perps 0 to 233 and 11 more from 4095 to 10902, spot 2048 to 2058 and 4510. ANT (10902) was created at 12:58 UTC that day; before it there were 256. A symbol is not unique: ASELS is both 8286 and 10635.
- In S3, `market_id` is an internal slot that Lighter reuses, and `public_market_index` is the public id. On 2026-11-16 slot 51 traded PRL (public 4097, decimals 2/4) on 9,398 rows, while public 51 is RESOLV (inactive, decimals 0/6), with no rows (P3). 8 listed markets traded that day under a slot other than their public id: OURA, PRL, IREN, DRV, TUR30, XTEN, STONK (slot 234) and weETH/USDC (slot 2055).
- `public_market_index` is null in all 580 files before 2026-08-20 and in none of the 88 after it. On 2026-08-20 it is filled from 07:59:20.689 UTC. From 2026-08-20 to 2026-08-24, no filled row differs from its slot, and the first market with a public id of 4095 or more (STONK) was created on 2026-09-15 (P4). So the public id of every row is `coalesce(public_market_index, market_id)`. Join and filter on that, never on the slot.
- Rows whose public id has no `orderBookDetails` entry are binary options: 193 public ids and 5,806 rows on 2026-11-16, with trade types `trade` and `market-settlement`. Counting by slot instead gives 194 and 14,328, because it also takes STONK's 8,522 rows (slot 234, public 4095) for binary options.
- Account `281474976710655` (2^48 − 1) means no account. It is one side of each of the 1,874 `market-settlement` rows on 2026-11-16.

## Units

- **Size, price and notional.** In S3, `size / 10^size_decimals` is base units, `price / 10^price_decimals` is USDC per base unit, and `usdc_amount / 10^6` is USDC; the decimals come from `orderBookDetails`. Trade 40627877458 (ETH, decimals 4/2, 2026-11-16 00:36:33 UTC): `size` 3491, `price` 181952, `usdc_amount` 635194432, so 0.3491 × 1819.52 = 635.194432 USDC exactly. The API sends the same trade as `"0.3491"`, `"1819.52"`, `"635.194432"` (P1). `size * price = usdc_amount` held on every row of 2025-01-17, 2025-06-01 and 2025-12-01, and failed on 6 of 1,829,859 rows of 2026-06-01.
- **Trade fees** are parts per million of notional. Σ `usdc_amount × maker_fee` / 10^12 over 2026-11-16 is 69,773.74 USDC, and `exchangeMetrics` `maker_fee` for that day is 69,773.74. The taker sum is 71,115.85 on rows other than liquidations, equal to `taker_fee`, and 10,689.95 on liquidations, equal to `liquidation_fee` (P6). The maker values seen, 40, 39, 38, 36, 34, 32, 30 and 28, are the eight Premium tiers on the account-types page (0.0040% to 0.0028%); 50 is Plus (0.005%) and 0 Standard. Taker values include the eight Premium tiers (280 to 196), Plus 50, Standard 0, and 100 (1 bp), which the tier tables do not list. Most liquidations pay 10000 (1%), the `liquidation_fee` of `1.0000` percent in `orderBookDetails`.
- **PnL.** `ask_account_pnl` and `bid_account_pnl` are realized PnL in USDC × 10^6, null when none. S3 holds both sides. The API holds only the queried account's side, as a decimal string with 6 places (P9).
- **Positions.** `*_position_size_before` is signed and scaled like `size`; `*_entry_quote_before` like `usdc_amount`. Both equal the API's decimal strings on the queried account's side (P9). `*_initial_margin_fraction_before` is in 1/10^4: 500 is 5%.
- **Funding.** `rate` is percent per hour, unsigned, with 4 decimals. `value` is USDC per one unit of base: ETH at 2026-10-17 07:00 UTC has `value` 0.01216590 and `rate` 0.0005, and 0.01216590 / (0.0005 / 100) = 2433.18, inside that hour's mark candle (open 2432.00, close 2433.88, low 2429.44, high 2436.92) (P5). `direction` gives the sign: `long` for a positive rate and `short` for a negative one (P10). That `long` means longs pay shorts is inferred from the funding page's rule, not stated for `direction`.
- **Times.** Trade `timestamp` and candle `t` are Unix ms, `transaction_time` Unix µs, funding and metric timestamps Unix s, `orderBookDetails` `created_at` Unix ms as a string.

## Paging traps

- **Newest N, silently.** `candles` and `markPriceCandles` return at most 500 rows, `fundings` 750. A longer range returns the newest rows and drops the oldest with no error: a 600-minute 1m range gave 500 candles starting 100.8 minutes after the start, and an 800-hour range gave 750 fundings starting 50.4 hours after it (P7). Keep every window within 500 buckets or 750 hours.
- **The open candle.** Both candle endpoints end with the bucket still open: at 13:36:11 UTC the last 1m candle was 13:36. Keep a candle only once its end is before the request time.
- **Funding hours.** A funding entry's `timestamp` is the hour mark it is paid at: at 13:36 UTC the newest entry was 13:00, and its rate equals the `funding_rate` the WebSocket reports for `funding_timestamp` 13:00. No entry came back for the hour then accruing. The 14:00 entry was there 16 s after the hour, with rate 0.0007, and unchanged at 14:00:57. A zero is not a sign of an open hour: ETH's 12:00 entry was `"0.0000"` on both 2026-11-16 and 2026-11-17, long after those hours closed.
- **Zero fields.** The candles page says zero values are left out, but 57 RESOLV 1d candles with no trades came back with `"v":0` and `"V":0`. The Trade schema says the same. Read every field as optional.
- **`trades` stops early for a busy account.** For account 313004, `next_cursor` ran out after 30 pages and 2,991 trades on both reads, reaching back to 09:03 UTC at 13:25 and to 09:46 at 14:04, and `from=` an older trade id returned no trades. For account 757337, `from=40627877459` reached 2026-11-14. S3 holds every trade; use it.
- **`trades` hides the other side.** Asked by `account_index`, the API sends `maker_fee` only when that account is the maker and `taker_fee` only when it is the taker, pnl only on its side, and zeros for the other side's position. Its `cursor` is base64 of `{"index":<last trade_id>}`, and `from=<trade_id>` pages the same way.

## S3 files

- `trades/date=YYYY-MM-DD/trades.parquet` and `open_interest_hourly/date=YYYY-MM-DD/oi.parquet`, one file per UTC day from 2025-01-17. 669 trade files to 2026-11-16, none missing. 2026-11-16's two files appeared at 07:02:54 UTC on 2026-11-17; the trade files of 2026-11-10 to 2026-11-15 landed between 07:03:24 and 07:04:02 UTC the next day.
- Trades: Parquet with ZSTD, row groups of up to 1,000,000 rows in id order. Each file holds its day's trades by `timestamp` in UTC. 2,195,712 rows and 211,750,965 bytes on 2026-11-16, 8,363,206 rows on 2025-12-01.
- The reads retry on a 429, a 5xx, a network error, a timeout and a download of the wrong size, after 2 s, 10 s and 60 s, or after a `Retry-After` wait capped at 2 minutes. Any other 4xx fails at once. A listing page has a 60 s deadline and a day-file download 30 minutes, each counted to the end of the body.
- The file has 43 columns. DuckDB adds a 44th, `date`, from the `date=` folder when it reads the S3 path. `vendor.yaml` lists each column's unit.
- No row group can be skipped by account or market: in all three row groups of 2026-11-16 the footer stats span `market_id` 0 to 2056 or more and both account ids from 93 or less to 2^48 − 1. A filtered read still reads every row group.
- Trade types on 2026-11-16: `trade` 2,192,564, `market-settlement` 1,874, `liquidation` 1,272, `deleverage` 2.
- Open interest: `hour` (timestamp with time zone, the start of the hour; the row is the end-of-hour snapshot), `symbol`, `open_interest` (base units), `mark_price`, `open_interest_usd` (`open_interest × mark_price`). 5,006 rows and 209 symbols on 2026-11-16, 118,471 bytes. It names markets by symbol only, and a symbol can name two listed markets (ASELS, under Market identity). A join to `orderBookDetails` on symbol alone matches both and counts the reading twice, so leave a symbol that names more than one market unmatched.

## Exchange metrics

`GET /api/v1/exchangeMetrics?period=all&kind=K[&filter=byMarket&value=SYMBOL]` returns one point per UTC day, with `timestamp` in Unix s at 00:00. Each daily kind had 669 points, from 2025-01-17 to 2026-11-16, and none for 2026-11-17 at 13:30 UTC. `buyback` and `buyback_usdc` start on 2025-12-30 (322 points).

- `byMarket` works for 10 kinds: `volume`, `maker_fee`, `taker_fee`, `liquidation_fee`, `trade_count`, `liquidation_count`, `liquidation_volume`, `open_interest`, `attribution_maker_fee`, `attribution_taker_fee`.
- For 8 kinds the reply with `byMarket` is byte for byte the exchange-wide one: `account_count`, `active_account_count`, `inflow`, `outflow`, `transfer_fee`, `withdraw_fee`, `buyback`, `buyback_usdc`.
- `value` is the symbol and is case-sensitive. `ETH` works; `eth` and `NOPE` return 669 points of 0 with code 200, not an error. Check a series is not all zeros.
- `tps` takes `period` h, d or w (`all` gets HTTP 400) and returns 5-minute points with `timestamp` in Unix ms: 288 for `d`.
- Units proven against S3 for 2026-11-16: `volume` 2,415,627,603.12 USDC = Σ `usdc_amount` / 10^6; the three fee kinds as in Units; `trade_count` 2,195,712 = the row count (P2); for ETH, `volume` 439,529,007.06, `maker_fee` 12,546.20, `trade_count` 285,981 and `liquidation_volume` 174,708.86 match the rows with public id 0. `liquidation_count` 1,274 = 1,272 liquidations + 2 deleverages. The other kinds' units are unproven.

## For plan 2

Plan 2 reads the Explorer and six exchange endpoints that plan 1 does not: `account`, `accountsByL1Address`, `pnl`, `assetDetails`, `systemConfig` and `publicPoolsMetadata`. The facts below come from replies on 2026-11-17 and 2026-11-18. The plan 2 proof table at the end rebuilds them as rows L11 to L27; plan 1's P16 rebuilds the first look at `tx`, `logs/{hash}` and batch ranges.

Four answers that later tasks branch on:

- **No two log entries share a hash.** A walk of 313004's ledger types from 2026-11-18 12:57 UTC back to 2026-11-14 read 5,116 entries: 5,110 distinct entries with 5,110 distinct hashes. The 6 extra were exact copies, each the last entry of one page and the first of the next, pushed down by new entries during the walk (L19). A key of account and hash keeps each entry once.
- **A deposit can settle in either final status.** The 5 deposits and 1 withdrawal of 313004 and 693073 that L20 read, from 2026-11-16 on, sit in `executed` batches whose ranges hold their blocks, and 11 of their 27 transfers in `nothing_to_execute` batches (L20). But 693073's deposit `00000000001e620a3d00000130000000000000000000000000000000000000000000000000000000`, at 2026-11-18 13:47:13.691, sits in batch 270960, which went `committed` at 13:54:23 and `nothing_to_execute` at 14:14:23 with no execute hash (L20). So a money move has settled once its batch is `executed` or `nothing_to_execute`, and a deposit may have no execute tx. Each withdrawal checked sat in an `executed` batch (L16, L20).
- **The side that `direction` names pays.** Across 13:00 UTC on 2026-11-18, nine pool accounts with no log entry in between changed `collateral` by −signed position × `value` on each position whose market's `direction` was `long`, and by +signed position × `value` where it was `short`, signed position being long-positive. On all 131 positions with a non-zero amount, `total_funding_paid_out` moved by that amount within the rounding of `value`'s 8 decimals, and on none by the opposite sign. Seven of them did the same across 14:00 (L21).
- **`tx` forgets old txs.** On 2026-11-18 it found 313004's txs from 2026-08-20 04:00:01 UTC on, and none from 03:59:58 or before (L18). The edge had not moved between 13:07 and 14:02, so it is not an hourly rolling window; whether it is fixed or moves daily is unproven. Plan 2 does not use it: `logs/{hash}` reaches back to 2025-08-25.

### Explorer

- `https://explorer.elliot.ai/api/` allows 45 weight a minute per IP, burst 45. Account logs weigh 4, `blocks/{n}` 5, `search` 3, account positions 2, every other path 1. Plan 2's client starts each request at least w × 60000 / `LIGHTER_EXPLORER_WEIGHT_PER_MINUTE` ms after the previous one, w being the previous request's weight. The three Explorer sources take shares of 25, 15 and 5.
- It holds batches from 28910 on. Batch 28910's first block, 41849406, is at 2025-08-25 15:28:03.691073 UTC; 28909 answers 404 (L11), as do 1, 2 and 10000. Account 1000's oldest ledger entry is from 2025-08-28, though its `pnl` series starts on 2025-03-13: the Explorer has nothing older.
- Errors come as `{"error":"…"}`: HTTP 400 `invalid pubDataType=Nope`, `invalid aggregation_period: day` and `aggregation_period parameter is required`; HTTP 404 `batch=28909 not found with block=0` and `log deadbeef not found`. An unknown account's logs are `[]` with HTTP 200.
- **The comma-only filter.** `pub_data_type` takes several types only as one comma-separated value. For account 1000, `pub_data_type=L1Deposit&pub_data_type=WithdrawV2` returned 9 entries, all `L1Deposit`; `pub_data_type=L1Deposit,WithdrawV2` returned those 9 and the `WithdrawV2` (L13). A repeated parameter drops every type after the first, with no error. All 39 types but `Empty` and `Trade` in one value work; an unknown type answers 400.
- `stats/tx?aggregation_period=1h` returns `{"data":{"chart":{"types":["timestamp","count","uopsCount"],"data":[[1759363200,3571651,3571651],…]}}}`. At 13:11 UTC on 2026-11-18 it held 9,902 hourly points from 2025-10-02 00:00 to 2026-11-18 13:00, 3,600 s apart with no gap, in 289,879 bytes. The last point is the hour still open. `1h` is the only period.
- `blocks/{n}` gives a block's batch, status, tx count, a few of its logs (2 of block 392559906's 500 txs) and 210 market prices. A batch reply already lists each block's time and tx count, so plan 2 calls neither block path. Explorer `accounts/{p}/positions` and `/assets` give positions by market (`market_index, pnl, side, size, entry_price`) and balances by asset id; `account` gives the same with more fields, under the exchange API's own limit.

### Batches and L1 settlement

- `GET /batches` returns 20 recent batches ordered by `updated_at`, not by number, each `batch_number, updated_at, batch_size, batch_status, batch_details`. A batch not yet committed comes with `batch_status` null and `batch_details` `{}`. It ignores `limit`: `?limit=5` gave 20. The highest `batch_number` is the head: 270939 at 13:11 UTC on 2026-11-18.
- `GET /batches/{n}` returns `batch_number, updated_at, batch_details {commit_tx_hash, verify_tx_hash, execute_tx_hash}, blocks [{block_number, updated_at, total_transactions}], status_changes [{hash, updated_at, batch_status}]`: 152,617 bytes for the 1,600 blocks of 270062.
- A batch is a contiguous block range, and consecutive batches meet: 270062 holds 391215230 to 391216829, 270063 391216830 to 391218429, and 270064 391218430 to 391220029 (L12). Batch 268847 holds 389271230 to 389272829, and batch 100000 starts at 125735109, the block after 99999 ends (P16). Sizes vary: 338 blocks in 28910, 305 in 50000, 427 in 109274, and 1,600 in 99999, 100000, 200000, 250000 and every batch read from November 2026. About 830 batches a day close now.
- Status goes `committed` → `verified` → `executed` (270062 on 2026-11-17: 11:54:23, 12:08:59, 12:08:59), or `committed` → `nothing_to_execute`, which carries the verify hash and no execute hash (270063: 11:55:35, 12:09:23; 270064: 11:56:59, 12:14:35). Every withdrawal checked sits in an `executed` batch; deposits and transfers sit in either (L16, L20). So `nothing_to_execute` marks a verified batch with no L1 work left: it is final, like `executed`.
- **Batches 28910 to 29653 have no status.** Their `batch_details` is null and `status_changes` empty, on every batch read in that span (28910, 29537, 29615, 29634, 29644, 29649, 29651, 29652, 29653). Batches 29654 to 29668 have status changes but no `committed` one: 29654 only `nothing_to_execute`, 29655 `verified` then `executed`. From 29669 on, each batch read starts with `committed` (L11). A rule that waits for `executed` or `nothing_to_execute` never closes a batch below 29654.
- One execute tx can close several batches: 270092 and 270093 share `0x3446be37…`, both executed at 13:08:35 on 2026-11-17 (L12).
- L1 commits can lag by hours. Batch 270063's blocks (11:46 to 11:47) were committed at 11:55. Batch 269235, which holds a deposit made at 2026-11-16 11:09:41, was committed at 18:03:35 and executed at 18:08:47; every batch in L20 holding an entry from 10:34 to 11:37 that day was executed between 18:02 and 18:14.
- **The settlement link.** `logs/{hash}` gives an entry's `block_number` and `batch_number`; the batch whose range holds that block gives the L1 hashes and times. Account 1000's `L1Withdraw` at 2025-12-30 08:38:14.781 sits in block 137652420 and batch 109274 (137652412 to 137652838), which was committed at 10:50:11, verified at 11:31:11 and executed at 11:33:23 by `0x23a3d85c…` (L16). In all 33 entries of L20, the batch that `logs/{hash}` names holds the entry's block.

### Account logs

- `GET /accounts/{index}/logs?pub_data_type=…&limit=…&offset=…` pages newest first by `offset`, `limit` up to at least 100. Entries carry `tx_type, hash, time, pubdata {<kind>_pubdata: {…}}, pubdata_type, status` and no block number (P16). `status` is the entry's batch status, null until batched: on all 33 entries of L20 it equals the batch's last status change.
- `time` is UTC with 0 to 6 decimals on the seconds, trailing zeros cut: `2026-11-17T10:40:31.59Z`, `2026-11-17T11:03:09Z`, `2025-12-13T14:11:49.813562Z`. Parse it as a time; text order fails within a second.
- Plan 2 asks for `LEDGER_TYPES`: the docs' 41 `PubDataType` values less `Empty` and `Trade`, 39 in one comma-separated value. Entries of `DETAIL_TYPES` also get a `logs/{hash}` call: `L1Deposit`, `L1DepositV2`, `Withdraw`, `WithdrawV2`, `L2Transfer`, `L2TransferV2`, `L2UpdateMargin`, `L2MintShares`, `BurnedShares`, `L2StakeAssets`, `UnstakeAssets`, `ExecutedPendingUnlock`, `ExitPosition` and `ExitPositionWithFunding`.
- **Units.** Values are decimal strings with the asset's decimals (`"104503.000000"` USDC, `"42328.20000000"` LIT), assets are symbols (`"asset_index":"USDC"`) and routes are `PERPS` or `SPOT`. One exception: `deleverage_pubdata_with_funding.quote` is an integer string (`"100958557736"`) next to a decimal `size` (`"0.90000"`).
- V1 and V2 shapes coexist: `l1_deposit_pubdata {l1_address, usdc_amount, account_index}`; `l1_deposit_pubdata_v2 {account_index, l1_address, asset_index, route_type, accepted_amount}`; `withdraw_pubdata {from_account_index, usdc_amount}`; `withdraw_pubdata_v2 {from_account_index, asset_index, route_type, amount}`; `l2_transfer_pubdata {from_account_index, to_account_index, usdc_amount}`; `l2_transfer_pubdata_v2 {from_account_index, to_account_index, fee_account_index, asset_index, from_route_type, to_route_type, amount, usdc_fee}`. A transfer with `from = to` moves funds between one account's routes: account 1000 moved 104508.6 USDC from SPOT to PERPS at 2025-12-30 08:07:07.
- Pool, staking and margin shapes, each from one real entry (L22 to L27): `l2_mint_shares_pubdata {account_index, public_pool_index, share_amount, usdc_amount}`; `burned_shares_pubdata {account_index, public_pool_index, shares_to_burn, operator_fee_share_amount, shares_to_burn_usdc}`; `l2_stake_assets_pubdata {account_index, staking_pool_index, share_amount, lit_amount}`; `unstake_assets_pubdata` with the same keys; `executed_pending_unlock_pubdata {account_index, asset_symbol, amount}`; `l2_update_margin_pubdata {account_index, market_index, usdc_amount, direction}`. Pool and market indexes are JSON numbers, not strings. 693073 unstaked 10228.37989914 LIT on 2026-10-01 and an unlock of that amount followed on 2026-10-04, with a made-up hash and `tx_type` `InternalPendingUnlock`. What `direction` means on a margin update, and which way stake, unstake and unlock move a balance, are unproven.
- **Hashes.** Each fill gets its own hash. An order of 313004 that filled twice against maker 702389 at 12:19:09.815 on 2026-11-17 shows as an `L2CreateOrder` entry (size 0.0071) and an `InternalClaimOrder` entry (0.3895) with a made-up hash, `000000234fdcd5fa000001a1e9726177…`. L1 withdrawals get the same kind: `00000000001782c02e00000130…` (L16). No two distinct entries share a hash in L19.
- **The walk.** New entries push old ones onto the next page, so a walk by `offset` reads some entries twice: 6 in L19's 52 pages. 313004's ledger types from 2026-11-14 04:26 to 2026-11-18 12:57 are 5,115 `TradeWithFunding` and 1 `WithdrawV2`, about 1,170 a day, or 12 pages. Its plain `Trade` entries, over 100K a week, are what the filter skips.
- `GET /logs/{hash}` returns the entry plus `block_number` and `batch_number`, null until batched. It answers for any entry since 2025-08-25 (L16). The deposit `00000000001e5aa83d…` of account 693073 sits in block 389893328 and batch 269235 (389892030 to 389893629), executed at 18:08:47 on 2026-11-16 by `0x0fc6217e…`. For trade 40627877458's hash it gives block 389272097 and batch 268847 (P16).
- `GET /api/v1/tx?by=hash` also gives a block, as `block_height`, but only for txs from 2026-08-20 04:00 on (L18). For trade 40627877458's hash it gave 389272097, equal to the API trade's `block_height` and S3's `l2_block_height`, with `type` 14 (P16).
- **Fast withdrawals.** Transfers to account 675395 carry fees: 1900.9 USDC from 20000 with `usdc_fee` 3.000000, and 5 USDC from 1000 just before its 104503 withdrawal. 675395 received 95 `L2TransferV2` in 13 hours on 2026-11-17, most with fee 1.000000, and made 5 withdrawals. The docs describe a fast withdrawal as a transfer to the fast-withdraw pool, so 675395 is likely that pool; only plan 3's `fastwithdraw/info` names it.

### Account value

- `GET /api/v1/pnl?by=index&value=…&resolution=…&start_timestamp=…&end_timestamp=…&count_back=0`, times in seconds, returns `pnl` points of `timestamp, trade_pnl, trade_spot_pnl, inflow, outflow, spot_inflow, spot_outflow, pool_pnl, pool_inflow, pool_outflow, staking_pnl, staking_inflow, staking_outflow, pool_total_shares, volume`. Values are JSON numbers with up to 6 decimals, not strings. Every field but `volume` is a running total since the account began.
- `1d` gives one point per UTC midnight from the account's first day, whatever the start, then one at the request time. Asked from 2025-01-01 at 12:56 on 2026-11-18, account 1000 had 617 points from 2025-03-13, the last at 12:56:27 (L14). The point at midnight D holds the totals up to D.
- **The `1h` cap.** `1h` answers ranges up to just under 10 days: 7 days gave 169 points, 8 days 193 and 9 days 217, and 10 days answered 400 `{"code":22403,"message":"time range exceeds maximum allowed range for the specified resolution"}` (L17). At 12:57:49, 863,993 s answered and 863,994 s did not. The docs say `1h` covers the last 10 days.
- **Perps value.** `inflow − outflow + trade_pnl` is the account's perps value. Account 1000, idle since 2025-12-30: 156508.908444 − 153478.114476 − 3030.185271 = 0.608697, its `collateral` and `total_asset_value` (L14). Account 313004 at 12:16:53 on 2026-11-17: 20006.337415 − 4.867955 + 77970.108827 = 97971.578287, its `total_asset_value` read the same minute.
- **Flows.** Day-to-day changes of `inflow` and `outflow` are the account's USDC money moves, each fee included (L15). Account 20000 on 2025-12-30, that is point 2025-12-31 less point 2025-12-30: `outflow` +1903.9, its transfer of 1900.9 plus the 3.000000 `usdc_fee`; `inflow` +1772.799436, its SPOT → PERPS move of 1758.29 plus a pool burn of 14.509436; `spot_outflow` +1758.29; `pool_outflow` +14.509436. Account 1000 that day: `inflow` +104508.6 (SPOT → PERPS), `spot_outflow` +104508.6, and `outflow` +104508 (a withdrawal of 104503 and a transfer of 5). On 2025-10-11 a burn of 7399.753218 raised its `inflow` and `pool_outflow` by that amount, and a v1 transfer of 7399.75 raised `outflow`. A mint counts as `outflow` and `pool_inflow` (161.998465 in the point of 2025-03-14). Account 20000's transfer of 652.4 LIT moved none of these fields.
- **Snapshots.** `GET /api/v1/account?by=index&value=…` returns `accounts[0]` with `index, l1_address, account_type, status, collateral, available_balance, total_asset_value, cross_asset_value, cross_initial_margin_requirement, cross_maintenance_margin_requirement, transaction_time` (µs), `positions [{market_id, symbol, sign, position, avg_entry_price, position_value, unrealized_pnl, realized_pnl, total_funding_paid_out?, liquidation_price, margin_mode, allocated_margin, initial_margin_fraction, …}]`, `assets [{symbol, asset_id, balance, locked_balance, margin_mode, margin_balance, multiplier}]`, `shares` and `pending_unlocks`. Closed positions stay listed with `position` 0. `collateral` leaves out unrealized pnl: 313004 had collateral 97972.003001, unrealized −0.424714 and total value 97971.578287. `position` is unsigned and `sign` is 1 or −1. An unknown index answers 400 `{"code":29404,"message":"not found"}`.
- Funding lands in `collateral` at each hour mark on every open position, with no log entry (L21). The change in a position's `total_funding_paid_out` is the funding it received, negative when it paid, whatever the name says. The field is missing on some positions and was 0 on one just opened.
- `GET /api/v1/accountsByL1Address?l1_address=…` returns `{code, l1_address, sub_accounts}`, every account of the address: `0x948bD698…d589` has one, 1000. An unknown address answers 400 `{"code":21100,"message":"account not found"}`.

### Funding prefix sums

- `trade_pubdata_with_funding` carries the market's `funding_rate_prefix_sum`, as do the exit and deleverage kinds with funding. At each hour mark it steps by +10^8 × that hour's `fundings` `value` when `direction` is `long`, and by −10^8 × `value` when `short`. All 5,193 ETH `TradeWithFunding` entries of 313004 from 2026-11-13 20:56 to 2026-11-18 12:57 carry the first entry's prefix plus the steps of the 112 hour marks between, 15 of them `short` (L21). At 13:00:01 on 2026-11-17 it went from 36577479997 to 36579121156: 1,641,159 = 10^8 × 0.01641159, that hour's `long` value. An hour with `value` 0 does not move it.
- All 5,193 of those entries were 313004's as taker, so the type does not say which side's funding settled.
- The prefix sum is the market's running total; it is not when funding is booked. `account` books funding at the hour mark on positions that do not trade (L21). The funding a position pays for an hour is its position times `value`, signed as above.
- `value` has 8 decimals, so position × `value` can miss the booked amount by up to |position| × 0.5 × 10^-8. At 13:00 on 2026-11-18, the 355200 1000PEPE long of pool 281474976489166 paid 0.016005, against 0.017760 from `value` 0.00000005. Pool 281474976688087, with 54 positions, paid 9.744738 against 9.545582 from `value`. A tolerance of 0.000002 per row holds only where |position| × 0.5 × 10^-8 stays under it.

## Proof table

Every command ran on 2026-11-17 and printed the value in the table. Run them in an empty folder with `curl`, `jq` and the `duckdb` CLI (1.5.4 here); P10 also needs `uv`. Set:

```sh
API=https://mainnet.zklighter.elliot.ai/api/v1
S3=https://aws-public-blockchain.s3.amazonaws.com/v1.1/lighter/core/mainnet
DAY16="$S3/trades/date=2026-11-16/trades.parquet"
```

Space API calls 1.1 s apart to stay under 60 a minute.

| # | Fact | Value |
|---|---|---|
| P1 | Decimals: trade 40627877458 in S3, the ETH market, and the same trade from the API; then `size * price = usdc_amount` on four days | `40627877458,0,0,3491,181952,635194432,true`; `["ETH",4,2,6]`; `[40627877458,"ETH","0.3491","1819.52","635.194432"]`; rows off 0 of 10,618, 0 of 310,096, 0 of 8,363,206, 6 of 1,829,859 |
| P2 | `trade_count` for 2026-11-16 equals the file's row count | 2195712 and `{"timestamp":1794787200,"data":2195712}` of 669 points; 211750965 bytes |
| P3 | Slot 51 is PRL (public 4097); public 51 is RESOLV; binary options by public id | `51,4097,9398`; `[51,"RESOLV","inactive",0,6]`, `[4097,"PRL","active",2,4]`; 193 ids, 5,806 rows; by slot, STONK `234,4095,8522` |
| P4 | First filled day of `public_market_index` | before 2026-08-20: 580 files, all null; from it: 89 files, 88 with no null; 10,259,674 filled rows on 2026-08-20 to 24, 0 differ, first at 2026-08-20 07:59:20.689; first id ≥ 4095 is STONK, 2026-09-15T12:15:35Z |
| P5 | ETH funding at 2026-10-17 07:00 UTC against the mark price | `["0.01216590","0.0005","long",2433.18]`; mark candle `[2432,2436.92,2429.44,2433.88]` |
| P6 | Fee tiers and units | maker_fee values 0, 28, 30, 32, 34, 36, 38, 39, 40, 50; sums 2415627603.12, 69773.74, 71115.85, 10689.95 equal `exchangeMetrics` volume, maker_fee, taker_fee, liquidation_fee |
| P7 | 500 and 750 caps, and the open candle | candles and markPriceCandles: 500 rows, the first about 100 minutes after the start, the last under 60 s old; fundings: 750 rows, the first about 50 hours after the start |
| P8 | Trade ids are unique across 2026-11-15 and 2026-11-16 | `true,4484699` |
| P9 | API fields against S3 for account 757337's 104 trades on 2026-11-16 | `104,104,104,104,104,21,21,31,31,104,104`: size, price, usd_amount and own fee equal on all 104; pnl × 10^6 equal on all 21 ask and 31 bid; own position size and entry quote before the trade equal on all 104 |
| P9a | The brief's walk for account 313004 | at 13:25 UTC: 30 pages, 2,991 trades, oldest 40938037620 at 09:03:15; at 14:04: 30 pages, 2,991 trades, oldest 40945769300 at 09:46:01; `from=` the oldest returns `[200,0,null]` |
| P10 | `direction` is `long` exactly when the WebSocket's signed `funding_rate` is positive | `14:00 UTC: 40 markets, 30 negative; 40 where funding_rate = rate, signed - for short` |
| P11 | Limits, from the rate-limits page | Standard `60 requests per rolling minute`; weights `exchangeMetrics` 120, `trades` 200, other 300, `recentTrades` 600; Explorer 45 a minute, burst 45; `HTTP 429`, or `HTTP 405`; firewall 60 s |
| P12 | Error bodies and retired paths | 20001, 22400, 21619 and 20001 with a reason, each HTTP 400; `blocks`, `txs`, `accountTxs`, `currentHeight`, `status`: 403 with `Server: CloudFront` |
| P13 | `orderBookDetails` contents | `[245,12,[["active",221],["inactive",36]],[6]]` |
| P14 | `exchangeMetrics` points, `byMarket`, symbol case, `tps`; ETH and liquidations against S3 | 669 points from 2025-01-17 to 2026-11-16 (`buyback`, `buyback_usdc`: 322 from 2025-12-30); same reply with `byMarket` for the 8 kinds; `["eth",669,0]`; `["tps",288,300000]`; ETH 439529007.06, 12546.2, 285981, 174708.86 from both; `liquidation_count` 1274 from both |
| P15 | S3 file times, layout and the open-interest file | 2026-11-10 to 2026-11-16 files at 07:02:54 to 07:04:02 the next day; row groups 1000000, 1000000, 195712, 43 columns, ZSTD; 44 columns through the S3 path; `5006,209`; the 5 open-interest columns and `date` |
| P16 | For plan 2 | `[389272097,14]`; `[389272097,268847,"L2CreateOrder"]`; account-log keys without a block number, newest first; batch 268847 `[1600,389271230,389272829,true]`; batches 50000, 99999, 100000 hold 305, 1600, 1600 blocks, and 100000 starts after 99999 ends |

P7, P9a, P10 and P13 read live data, so a rerun prints other numbers of the same shape: P7's counts stay 500 and 750 and its first row stays late, P9a's walk stops on the run day, P10's last two counts stay equal, and P13 grows as Lighter lists markets. P4's and P14's counts grow by one a day.

**P1.**

```sh
duckdb -csv -c "select id, market_id, public_market_index, size, price, usdc_amount, size * price = usdc_amount as exact from '$DAY16' where id = 40627877458"
curl -s "$API/orderBookDetails?market_id=0" | jq -c '.order_book_details[] | [.symbol, .size_decimals, .price_decimals, .supported_quote_decimals]'
curl -s "$API/trades?account_index=757337&sort_by=trade_id&limit=1&from=40627877459" | jq -c '.trades[0] | [.trade_id, .market_symbol, .size, .price, .usd_amount]'
duckdb -csv -c "SET s3_region = 'us-east-2'; select regexp_extract(filename, 'date=([0-9-]+)', 1) as day, count(*) as n, count(*) filter (where size * price <> usdc_amount) as off from read_parquet(['s3://aws-public-blockchain/v1.1/lighter/core/mainnet/trades/date=' || d || '/trades.parquet' for d in ['2025-01-17', '2025-06-01', '2025-12-01', '2026-06-01']], filename = true) group by 1 order by 1"
```

**P2.**

```sh
duckdb -csv -c "select count(*) as n from '$DAY16'"
curl -s "$API/exchangeMetrics?period=all&kind=trade_count" | jq -c '[(.metrics | length), (.metrics[] | select(.timestamp == 1794787200))]'
curl -sI "$DAY16" | grep -i '^content-length'
```

**P3.** The second query counts binary options by public id; the third shows the listed market that a count by slot would take for one.

```sh
duckdb -csv -c "select market_id, public_market_index, count(*) as n from '$DAY16' where market_id = 51 or public_market_index = 51 group by all"
curl -s "$API/orderBookDetails" > markets.json
jq -c '(.order_book_details + .spot_order_book_details)[] | select(.market_id == 51 or .market_id == 4097) | [.market_id, .symbol, .status, .size_decimals, .price_decimals]' markets.json
jq -r '(.order_book_details + .spot_order_book_details)[].market_id' markets.json > ids.csv
duckdb -csv -c "create view ids as select column0 as id from read_csv('ids.csv', header = false); select count(distinct coalesce(public_market_index, market_id)) as ids, count(*) as n_rows from '$DAY16' where coalesce(public_market_index, market_id) not in (select id from ids); select market_id, public_market_index, count(*) as n from '$DAY16' where market_id not in (select id from ids) and public_market_index in (select id from ids) group by all"
```

**P4.** The first query reads only the 669 file footers.

```sh
duckdb -csv -c "SET s3_region = 'us-east-2'; with f as (select regexp_extract(file_name, 'date=([0-9-]+)', 1) as day, sum(num_values) as n, sum(stats_null_count) as null_count from parquet_metadata('s3://aws-public-blockchain/v1.1/lighter/core/mainnet/trades/*/trades.parquet') where path_in_schema = 'public_market_index' group by 1) select day < '2026-08-20' as before, count(*) as files, min(day) as first, max(day) as last, count(*) filter (where n = null_count) as all_null, count(*) filter (where null_count = 0) as none_null from f group by 1 order by 1"
duckdb -csv -c "SET s3_region = 'us-east-2'; SET TimeZone = 'UTC'; select count(*) filter (where public_market_index is not null) as filled, count(*) filter (where public_market_index <> market_id) as differ, min(make_timestamp(timestamp * 1000)) filter (where public_market_index is not null) as first_filled from read_parquet('s3://aws-public-blockchain/v1.1/lighter/core/mainnet/trades/date=2026-08-2[0-4]/trades.parquet')"
jq -r '[(.order_book_details + .spot_order_book_details)[] | select(.market_id >= 4095)] | min_by(.created_at | tonumber) | [.market_id, .symbol, (.created_at | tonumber / 1000 | floor | todate)] | @csv' markets.json
```

**P5.**

```sh
curl -s "$API/fundings?market_id=0&resolution=1h&start_timestamp=1792216800000&end_timestamp=1792227600000&count_back=0" | jq -c '.fundings[] | select(.timestamp == 1792220400) | [.value, .rate, .direction, ((.value | tonumber) / ((.rate | tonumber) / 100) * 100 | round / 100)]'
curl -s "$API/markPriceCandles?market_id=0&resolution=1h&start_timestamp=1792216800000&end_timestamp=1792227600000&count_back=0" | jq -c '.c[] | select(.t == 1792220400000) | [.o, .h, .l, .c]'
```

**P6.**

```sh
duckdb -csv -c "select maker_fee, count(*) as n from '$DAY16' group by 1 order by 1"
duckdb -csv -c "select round(sum(usdc_amount) / 1e6, 2) as volume, round(sum(usdc_amount::hugeint * maker_fee) / 1e12, 2) as maker_fee, round(sum(usdc_amount::hugeint * taker_fee) filter (where trade_type <> 'liquidation') / 1e12, 2) as taker_fee, round(sum(usdc_amount::hugeint * taker_fee) filter (where trade_type = 'liquidation') / 1e12, 2) as liquidation_fee from '$DAY16'"
for k in volume maker_fee taker_fee liquidation_fee; do sleep 1.1; curl -s "$API/exchangeMetrics?period=all&kind=$k" | jq -c --arg k "$k" '[$k, (.metrics[] | select(.timestamp == 1794787200) | .data)]'; done
```

**P7.** Each line prints the row count, how far after the start the first row is (minutes, or hours for fundings), and how old the last row is (seconds).

```sh
NOW=$(date -u +%s)
for e in candles markPriceCandles; do sleep 1.1; curl -s "$API/$e?market_id=0&resolution=1m&start_timestamp=$(( (NOW - 36000) * 1000 ))&end_timestamp=$(( NOW * 1000 ))&count_back=0" | jq -c --arg e "$e" --argjson now "$NOW" '[$e, (.c | length), ((.c[0].t / 1000 - ($now - 36000)) / 60), ($now - .c[-1].t / 1000)]'; done
curl -s "$API/fundings?market_id=0&resolution=1h&start_timestamp=$(( (NOW - 2880000) * 1000 ))&end_timestamp=$(( NOW * 1000 ))&count_back=0" | jq -c --argjson now "$NOW" '["fundings", (.fundings | length), ((.fundings[0].timestamp - ($now - 2880000)) / 3600), ($now - .fundings[-1].timestamp)]'
```

**P8.**

```sh
duckdb -csv -c "select count(*) = count(distinct id) as unique_ids, count(*) as n from read_parquet(['$S3/trades/date=2026-11-15/trades.parquet', '$DAY16'])"
```

**P9.** Account 757337 is the maker of trade 40627877458. Its 104 trades on 2026-11-16 fit in two pages, from its newest trade that day (40839017087) down. The query prints n, size, price and usd_amount equal, own fee equal, then API ask pnl and how many equal S3 × 10^-6, then the same for bid, then how many of the account's own `position_size_before` and `entry_quote_before` equal S3 with the point removed.

```sh
curl -s "$API/trades?account_index=757337&sort_by=trade_id&limit=100&from=40839017088" > p9-1.json
curl -s "$API/trades?account_index=757337&sort_by=trade_id&limit=100&from=$(jq '.trades[-1].trade_id' p9-1.json)" > p9-2.json
duckdb -csv -c "create view api as select unnest(trades, recursive := true) from read_json(['p9-1.json', 'p9-2.json'], union_by_name = true); create view s3 as select * from '$DAY16' where 757337 in (ask_account_id, bid_account_id); select count(*) as n, count(*) filter (where replace(a.size, '.', '')::bigint = s.size) as size_eq, count(*) filter (where replace(a.price, '.', '')::bigint = s.price) as price_eq, count(*) filter (where replace(a.usd_amount, '.', '')::bigint = s.usdc_amount) as usd_eq, count(*) filter (where if((s.is_maker_ask and s.ask_account_id = 757337) or (not s.is_maker_ask and s.bid_account_id = 757337), a.maker_fee = s.maker_fee, a.taker_fee = s.taker_fee)) as own_fee_eq, count(a.ask_account_pnl) as ask_pnl, count(*) filter (where a.ask_account_pnl::decimal(38, 6) * 1000000 = s.ask_account_pnl) as ask_pnl_eq, count(a.bid_account_pnl) as bid_pnl, count(*) filter (where a.bid_account_pnl::decimal(38, 6) * 1000000 = s.bid_account_pnl) as bid_pnl_eq, count(*) filter (where replace(if((s.is_maker_ask and s.ask_account_id = 757337) or (not s.is_maker_ask and s.bid_account_id = 757337), a.maker_position_size_before, a.taker_position_size_before), '.', '')::bigint = if((s.is_maker_ask and s.ask_account_id = 757337) or (not s.is_maker_ask and s.bid_account_id = 757337), s.maker_position_size_before, s.taker_position_size_before)) as own_position_eq, count(*) filter (where replace(if((s.is_maker_ask and s.ask_account_id = 757337) or (not s.is_maker_ask and s.bid_account_id = 757337), a.maker_entry_quote_before, a.taker_entry_quote_before), '.', '')::bigint = if((s.is_maker_ask and s.ask_account_id = 757337) or (not s.is_maker_ask and s.bid_account_id = 757337), s.maker_entry_quote_before, s.taker_entry_quote_before)) as own_entry_quote_eq from api a join s3 s on s.id = a.trade_id"
```

The S3 file holds pnl on both sides: of the same 104 rows, 33 carry the other account's ask pnl and 28 its bid pnl, which the API leaves out.

Removing the point compares digits, so the scales must match too. In all 200 trades of the two pages, which span six size scales, the API writes each position with as many decimals as the trade's `size` and each entry quote with 6, as `usdc_amount` has:

```sh
duckdb -csv -c "with a as (select unnest(trades, recursive := true) from read_json(['p9-1.json', 'p9-2.json'], union_by_name = true)) select count(*) as n, count(*) filter (where length(split_part(maker_position_size_before, '.', 2)) = length(split_part(size, '.', 2)) and length(split_part(taker_position_size_before, '.', 2)) = length(split_part(size, '.', 2))) as position_places_match_size, count(*) filter (where length(split_part(maker_entry_quote_before, '.', 2)) = 6 and length(split_part(taker_entry_quote_before, '.', 2)) = 6) as entry_quote_6_places, count(distinct length(split_part(size, '.', 2))) as size_place_counts from a"
```

It prints `200,200,200,6`.

**P9a.** The brief asked for account 313004, walked by `next_cursor` until a trade falls before the current UTC day. Its cursor ran out first, both times after 2,991 trades, so P9 uses account 757337, whose history reaches back.

```sh
C=; P=0; N=0
while :; do
  sleep 1.1
  R=$(curl -s "$API/trades?account_index=313004&sort_by=trade_id&limit=100${C:+&cursor=$C}")
  P=$((P + 1)); N=$((N + $(echo "$R" | jq '.trades | length')))
  OLD=$(echo "$R" | jq '.trades[-1].trade_id'); OLDT=$(echo "$R" | jq '.trades[-1].timestamp')
  C=$(echo "$R" | jq -r '.next_cursor // empty')
  [ -z "$C" ] && break
done
echo "$P pages, $N trades, oldest $OLD at $(date -u -r $((OLDT / 1000)) +%FT%TZ)"
curl -s "$API/trades?account_index=313004&sort_by=trade_id&limit=100&from=$OLD" | jq -c '[.code, (.trades | length), .next_cursor]'
```

**P10.** The script reads one `market_stats/all` snapshot from the WebSocket, whose `funding_rate` is the last funding paid, signed. It takes the markets paid at the latest hour with a non-zero rate, all negative ones and ten positive ones, reads each one's `fundings` entry for that hour, and counts those where `funding_rate` equals `rate`, negated when `direction` is `short`.

```sh
uv run --quiet --no-project --with websockets==15.0.1 python - <<'PY'
import asyncio, json, time, urllib.request, websockets

async def stats():
    async with websockets.connect("wss://mainnet.zklighter.elliot.ai/stream", max_size=None) as ws:
        await ws.send(json.dumps({"type": "subscribe", "channel": "market_stats/all"}))
        while True:
            m = json.loads(await ws.recv())
            if isinstance(m.get("market_stats"), dict) and len(m["market_stats"]) > 50:
                return list(m["market_stats"].values())

s = asyncio.run(stats())
h = max(v["funding_timestamp"] for v in s) // 1000
last = [v for v in s if v["funding_timestamp"] // 1000 == h and float(v["funding_rate"]) != 0]
pick = [v for v in last if float(v["funding_rate"]) < 0] + [v for v in last if float(v["funding_rate"]) > 0][:10]
agree = 0
for v in pick:
    url = ("https://mainnet.zklighter.elliot.ai/api/v1/fundings?market_id=%d&resolution=1h&start_timestamp=%d"
           "&end_timestamp=%d&count_back=0" % (v["market_id"], (h - 3600) * 1000, (h + 3600) * 1000))
    f = {x["timestamp"]: x for x in json.load(urllib.request.urlopen(url))["fundings"]}.get(h)
    agree += f is not None and float(v["funding_rate"]) == (1 if f["direction"] == "long" else -1) * float(f["rate"])
    time.sleep(1.1)
print(time.strftime("%H:%M", time.gmtime(h)), "UTC:", len(pick), "markets,",
      sum(float(v["funding_rate"]) < 0 for v in pick), "negative;", agree, "where funding_rate = rate, signed - for short")
PY
```

Neither the `fundings` page nor the WebSocket's market-stats section says what `direction` means. The script proves only (a): `direction` is `long` exactly when the WebSocket's signed `funding_rate` is positive. (b) The funding page says "when the funding rate is positive, users with long positions pay a funding fee to users with short positions", but nothing ties that rule to the WebSocket field. (c) That `direction` names the paying side is inferred from (a) and (b).

**P11.** The page has a tab per exchange; the `awk` keeps the Lighter tab.

```sh
curl -s https://docs.lighter.xyz/developers/reference/rate-limits.md | awk '/tab title="Lighter on Robinhood/ {exit} {print}' | tr -s ' -' | grep -E '60 requests per rolling minute|^\| `(exchangeMetrics|trades|recentTrades)` \||^\| Other endpoints \| 300|You will receive|\*\*Firewall|All account types have a limit'
```

**P12.**

```sh
curl -s -w ' %{http_code}\n' "$API/candles?market_id=0&resolution=2m&start_timestamp=0&end_timestamp=1&count_back=0"
curl -s -w ' %{http_code}\n' "$API/fundings?market_id=0&resolution=1h&start_timestamp=2000&end_timestamp=1000&count_back=0"
curl -s -w ' %{http_code}\n' "$API/fundings?market_id=9999&resolution=1h&start_timestamp=1794913200000&end_timestamp=1794920400000&count_back=0"
curl -s -w ' %{http_code}\n' "$API/exchangeMetrics?period=all&kind=tps"
for p in blocks txs accountTxs currentHeight status; do sleep 1.1; echo "$p $(curl -s -o /dev/null -D - "$API/$p" | grep -iE '^(HTTP|server)' | tr -d '\r' | tr '\n' ' ')"; done
```

**P13.** Counts perp and spot markets, statuses, and quote decimals.

```sh
curl -s "$API/orderBookDetails" | jq -c '[(.order_book_details | length), (.spot_order_book_details | length), ([(.order_book_details + .spot_order_book_details)[].status] | group_by(.) | map([.[0], length])), ([(.order_book_details + .spot_order_book_details)[].supported_quote_decimals] | unique)]'
```

**P14.** The loop compares each kind's reply with and without `filter=byMarket&value=ETH`. The last two queries rebuild the ETH and liquidation numbers from S3.

```sh
for k in volume maker_fee taker_fee liquidation_fee trade_count liquidation_count liquidation_volume open_interest attribution_maker_fee attribution_taker_fee account_count active_account_count inflow outflow transfer_fee withdraw_fee buyback buyback_usdc; do
  sleep 1.1; A=$(curl -s "$API/exchangeMetrics?period=all&kind=$k")
  sleep 1.1; B=$(curl -s "$API/exchangeMetrics?period=all&kind=$k&filter=byMarket&value=ETH")
  echo "$k $(echo "$A" | jq -c '[(.metrics | length), (.metrics[0].timestamp | todate), (.metrics[-1].timestamp | todate)]') same_with_byMarket=$([ "$A" = "$B" ] && echo yes || echo no)"
done
curl -s "$API/exchangeMetrics?period=all&kind=volume&filter=byMarket&value=eth" | jq -c '["eth", (.metrics | length), ([.metrics[] | select(.data != 0)] | length)]'
curl -s "$API/exchangeMetrics?period=d&kind=tps" | jq -c '["tps", (.metrics | length), (.metrics[1].timestamp - .metrics[0].timestamp)]'
for k in volume maker_fee trade_count liquidation_volume; do sleep 1.1; curl -s "$API/exchangeMetrics?period=all&kind=$k&filter=byMarket&value=ETH" | jq -c --arg k "$k" '["ETH", $k, (.metrics[] | select(.timestamp == 1794787200) | .data)]'; done
curl -s "$API/exchangeMetrics?period=all&kind=liquidation_count" | jq -c '["liquidation_count", (.metrics[] | select(.timestamp == 1794787200) | .data)]'
duckdb -csv -c "select count(*) as trade_count, round(sum(usdc_amount) / 1e6, 2) as volume, round(sum(usdc_amount::hugeint * maker_fee) / 1e12, 2) as maker_fee, round(sum(usdc_amount) filter (where trade_type = 'liquidation') / 1e6, 2) as liquidation_volume from '$DAY16' where coalesce(public_market_index, market_id) = 0"
duckdb -csv -c "select count(*) filter (where trade_type in ('liquidation', 'deleverage')) as liquidation_count from '$DAY16'"
```

**P15.** The listing gives each file's key, upload time and size. `parquet_metadata` counts the file's own columns; `describe` over the S3 path adds `date`.

```sh
curl -s "https://aws-public-blockchain.s3.amazonaws.com/?list-type=2&prefix=v1.1/lighter/core/mainnet/trades/date=2026-11-1" | grep -oE '<Key>[^<]+|<LastModified>[^<]+|<Size>[^<]+' | sed 's/<[A-Za-z]*>//' | paste - - -
duckdb -csv -c "select row_group_id, any_value(row_group_num_rows) as n_rows, any_value(row_group_num_columns) as file_columns, any_value(compression) as compression from parquet_metadata('$DAY16') group by 1 order by 1"
duckdb -csv -c "select count(*) as columns from (describe select * from '$DAY16')"
duckdb -csv -c "select count(*) as n, count(distinct symbol) as symbols from '$S3/open_interest_hourly/date=2026-11-16/oi.parquet'"
duckdb -csv -c "select column_name, column_type from (describe select * from '$S3/open_interest_hourly/date=2026-11-16/oi.parquet')"
```

**P16.** Trade 40627877458's transaction, then the Explorer.

```sh
EXP=https://explorer.elliot.ai/api
curl -s "$API/tx?by=hash&value=5b112217f481515ca8cb8884e262fadfcacfd04cb2c88f906ff89fc61a8807761e5f6f070c1595d2" | jq -c '[.block_height, .type]'
curl -s "$EXP/logs/5b112217f481515ca8cb8884e262fadfcacfd04cb2c88f906ff89fc61a8807761e5f6f070c1595d2" | jq -c '[.block_number, .batch_number, .tx_type]'
curl -s "$EXP/accounts/757337/logs?limit=3&offset=0" | jq -c '[.[] | [.time, (keys | join(","))]]'
curl -s "$EXP/batches/268847" | jq -c '[(.blocks | length), .blocks[0].block_number, .blocks[-1].block_number, ((.blocks | map(.block_number)) == [range(.blocks[0].block_number; .blocks[0].block_number + (.blocks | length))])]'
for b in 50000 99999 100000; do sleep 2; curl -s "$EXP/batches/$b" | jq -c --arg b "$b" '[$b, (.blocks | length), .blocks[0].block_number, .blocks[-1].block_number]'; done
```

## Plan 2 proof table

Every command ran on 2026-11-18 and printed the value in the table. L<n> is plan 2's P<n>; plan 1's rows above keep their P ids. Run them in an empty folder with `curl`, `jq` and the `duckdb` CLI; L19 writes `l19.jsonl`, which L20 and L21 read. Set:

```sh
API=https://mainnet.zklighter.elliot.ai/api/v1
EXP=https://explorer.elliot.ai/api
S3=https://aws-public-blockchain.s3.amazonaws.com/v1.1/lighter/core/mainnet
LEDGER_TYPES=$(curl -s https://docs.lighter.xyz/api/explorer-api/account/get-account-by-address.md | grep -o '{"openapi.*' | jq -r '[.components.schemas["response.PubDataType"].enum[] | select(. != "Empty" and . != "Trade")] | join(",")')
```

Space Explorer calls by weight: 6 s after an account-log page, 2 s after any other read. Space API calls 1.1 s apart.

| # | Fact | Value |
|---|---|---|
| L11 | First batch; batches with no status or no commit | `[28910,41849406,"2025-08-25T15:28:03.691073Z",338,null,0]`; `{"error":"batch=28909 not found with block=0"} 404`; `[29653,false,[]]`, `[29654,true,["nothing_to_execute"]]`, `[29655,true,["verified","executed"]]`, `[29668,true,["nothing_to_execute"]]`, `[29669,true,["committed","nothing_to_execute"]]` |
| L12 | Ranges meet, sizes, statuses, a shared execute tx | `[270062,391215230,391216829,1600,true,"0x3da45976",[["committed","11:54:23"],["verified","12:08:59"],["executed","12:08:59"]]]`; `[270063,391216830,391218429,1600,true,"",[["committed","11:55:35"],["nothing_to_execute","12:09:23"]]]`; `[270064,391218430,391220029,1600,true,"",[["committed","11:56:59"],["nothing_to_execute","12:14:35"]]]`; `[109274,137652412,137652838,427,true,"0x23a3d85c",…]`; 270092 and 270093 both `"0x3446be37"`, `executed` at `13:08:35` |
| L13 | The comma filter on account 1000 | repeated: `[9,[["L1Deposit",9]]]`; comma: `[10,[["L1Deposit",9],["WithdrawV2",1]]]`; all 39 ledger types: `100`; `{"error":"invalid pubDataType=Nope"} 400` |
| L14 | The perps-value identity on account 1000 | `[617,"2025-03-13T00:00:00Z",0.608697]`; `["0.608697","0.608697"]` |
| L15 | The flow mapping on accounts 20000 and 1000 | 20000, 2025-12-31: `{"inflow":1772.799436,"outflow":1903.9,"spot_outflow":1758.29,"pool_inflow":0,"pool_outflow":14.509436}`; its log that day: `["16:37:20","L2TransferV2","1900.900000","3.000000"]`, `["16:37:11","L2TransferV2","1758.290000","0.000000"]`, `["16:37:05","BurnedShares","14.509436",null]`, `["05:14:18","L2TransferV2","652.40000000","0.000000"]`. 1000: 2025-12-31 `{"inflow":104508.6,"outflow":104508,"spot_outflow":104508.6,"pool_inflow":0,"pool_outflow":0}`; 2025-10-12 `{"inflow":7399.753218,"outflow":7399.75,"spot_outflow":0,"pool_inflow":0,"pool_outflow":7399.753218}`; 2025-03-14 `{"inflow":0,"outflow":161.998465,"spot_outflow":0,"pool_inflow":161.998465,"pool_outflow":0}` |
| L16 | The settlement link | `["L1Withdraw","2025-12-30T08:38:14.781Z",137652420,109274,"executed"]`; `[427,137652412,137652838,true,"0x23a3d85c",[["committed","2025-12-30T10:50:11Z"],["verified","2025-12-30T11:31:11Z"],["executed","2025-12-30T11:33:23Z"]]]`; `{"error":"log deadbeef not found"} 404` |
| L17 | The `1h` cap | `["7",200,169]`, `["8",200,193]`, `["9",200,217]`, `["10",22403,0]` |
| L18 | How far back `tx` finds 313004's txs | `2026-11-10T00:24:04Z [200,380945584]`, `2026-08-21T00:14:01Z [200,315784308]`, `2026-08-20T04:00:01Z [200,315095553]`, `2026-08-20T03:59:00Z [21500,null]`, `2026-06-01T00:19:46Z [21500,null]`, `2026-01-10T00:21:21Z [21500,null]` |
| L19 | No two entries of 313004's log share a hash | entries since 2026-11-14, distinct entries, distinct hashes, types. From 12:58: `52 pages`, `[5116,5110,5110,[["TradeWithFunding",5115],["WithdrawV2",1]]]`; from 13:30: `52 pages`, `[5159,5152,5152,[["TradeWithFunding",5158],["WithdrawV2",1]]]` |
| L20 | Where 313004's and 693073's money moves since 2026-11-16 settled; a deposit in a `nothing_to_execute` batch | `[["L1DepositV2","executed",5,5],["L2TransferV2","executed",16,16],["L2TransferV2","nothing_to_execute",11,11],["WithdrawV2","executed",1,1]]`; 693073's deposit of 13:47, read at 15:56: `["L1DepositV2","2026-11-18T13:47:13.691Z",392653609,270960,"nothing_to_execute"]`, `[270960,true,null,[["committed","2026-11-18T13:54:23Z"],["nothing_to_execute","2026-11-18T14:14:23Z"]]]` |
| L21 | The funding sign, and the prefix sum's steps | 13:00 on 2026-11-18, collateral change against the rule: `-14.612018, -14.612018` (624925, 1 position), `-15.637451, -15.637334` (622846, 9), `-0.007692, -0.007692` (489165), `-0.016005, -0.01776` (489166, 1000PEPE), `-0.027107, -0.027106` (552443), `-0.001463, -0.001462` (466894), `-0.683576, -0.683584` (498676, 2); no log entry between the readings. 14:00, the command as written: `["14:00",281474976624925,1,-14.578594,-14.578594]`, `[…622846,9,-16.273925,-16.273907]`, `[…489165,1,-0.007667,-0.007666]`, `[…489166,1,-0.015993,-0.01776]`, `[…552443,1,-0.027017,-0.027018]`, `[…466894,1,-0.001457,-0.001458]`, `[…498676,2,-0.702439,-0.702448]`, each newest log entry older than 13:59. Prefix, over the 12:58 walk: `[5193,5193,112,15]`; over the 13:30 walk: `[5192,5192,111,15]` |
| L22 | An `L2MintShares` entry of 1000 | `["L2MintShares","2025-10-02T16:22:41.699846Z",56276855,52271,{"l2_mint_shares_pubdata":{"account_index":"1000","public_pool_index":281474976710654,"share_amount":"2313338","usdc_amount":"7747.974151"}}]` |
| L23 | A `BurnedShares` entry of 1000 | `["BurnedShares","2025-10-11T10:26:09.382883Z",62014302,55980,{"burned_shares_pubdata":{"account_index":"1000","public_pool_index":281474976710654,"shares_to_burn":"2313340","operator_fee_share_amount":"0","shares_to_burn_usdc":"7399.753218"}}]` |
| L24 | An `L2StakeAssets` entry of 693073 | `["L2StakeAssets","2026-04-22T18:53:43.711Z",220451190,163328,{"l2_stake_assets_pubdata":{"account_index":"693073","staking_pool_index":281474976624800,"share_amount":"975743814","lit_amount":"10000.19000087"}}]` |
| L25 | An `UnstakeAssets` entry of 693073 | `["UnstakeAssets","2026-10-01T15:56:02.532Z",346424647,242066,{"unstake_assets_pubdata":{"account_index":"693073","staking_pool_index":281474976624800,"share_amount":"975743814","lit_amount":"10228.37989914"}}]` |
| L26 | An `ExecutedPendingUnlock` entry of 693073 | `["ExecutedPendingUnlock","2026-10-04T15:56:02.608Z",348316241,243248,{"executed_pending_unlock_pubdata":{"account_index":"693073","asset_symbol":"LIT","amount":"10228.37989914"}}]` |
| L27 | An `L2UpdateMargin` entry of 693073 | `["L2UpdateMargin","2026-09-09T14:39:54.465Z",329163051,231276,{"l2_update_margin_pubdata":{"account_index":"693073","market_index":93,"usdc_amount":"2.710264","direction":1}}]` |

L18, L19, L20 and L21 read live data, so a rerun prints other numbers of the same shape: L18's edge may move, L19's second and third numbers stay equal, L20's last two numbers stay equal on each line, and L21's two numbers stay within the rounding of `value` and its prefix counts stay equal. L14's count grows by one a day.

**L11.** Batch 28910, then the edges of the batches with no status (29653 and below) and with no commit (29654 to 29668).

```sh
curl -s "$EXP/batches/28910" | jq -c '[.batch_number, .blocks[0].block_number, .blocks[0].updated_at, (.blocks | length), .batch_details, (.status_changes | length)]'
sleep 2; curl -s -w ' %{http_code}\n' "$EXP/batches/28909"
for b in 29653 29654 29655 29668 29669; do sleep 2; curl -s "$EXP/batches/$b" | jq -c '[.batch_number, (.batch_details != null), [.status_changes[].batch_status]]'; done
```

**L12.** Each line prints the batch, its first and last block, the block count, whether the blocks run without a gap, the execute hash, and the status changes.

```sh
for b in 270062 270063 270064 109274 270092 270093; do sleep 2; curl -s "$EXP/batches/$b" | jq -c '[.batch_number, .blocks[0].block_number, .blocks[-1].block_number, (.blocks | length), (.blocks | map(.block_number) | . == [range(.[0]; .[0] + length)]), (.batch_details.execute_tx_hash // "" | .[0:10]), [.status_changes[] | [.batch_status, .updated_at[11:19]]]]'; done
```

**L13.**

```sh
curl -s "$EXP/accounts/1000/logs?pub_data_type=L1Deposit&pub_data_type=WithdrawV2&limit=100" | jq -c '[length, ([.[].pubdata_type] | group_by(.) | map([.[0], length]))]'
sleep 6; curl -s "$EXP/accounts/1000/logs?pub_data_type=L1Deposit,WithdrawV2&limit=100" | jq -c '[length, ([.[].pubdata_type] | group_by(.) | map([.[0], length]))]'
sleep 6; curl -s "$EXP/accounts/1000/logs?pub_data_type=$LEDGER_TYPES&limit=100" | jq 'length'
sleep 6; curl -s -w ' %{http_code}\n' "$EXP/accounts/1000/logs?pub_data_type=Nope"
```

**L14.** The first line prints the point count, the first point, and `inflow − outflow + trade_pnl` of the last point.

```sh
curl -s "$API/pnl?by=index&value=1000&resolution=1d&start_timestamp=1735689600&end_timestamp=$(date -u +%s)&count_back=0" | jq -c '[(.pnl | length), (.pnl[0].timestamp | todate), (.pnl[-1] | (.inflow - .outflow + .trade_pnl) * 1e6 | round / 1e6)]'
sleep 1.1; curl -s "$API/account?by=index&value=1000" | jq -c '.accounts[0] | [.collateral, .total_asset_value]'
```

**L15.** `DIFF` prints a point less the point a day before. The last line lists account 20000's money moves on 2025-12-30.

```sh
DIFF='def d(f): (.[1][f] - .[0][f]) * 1e6 | round / 1e6; [.pnl[] | select(.timestamp == ($day | fromdate) - 86400 or .timestamp == ($day | fromdate))] | {inflow: d("inflow"), outflow: d("outflow"), spot_outflow: d("spot_outflow"), pool_inflow: d("pool_inflow"), pool_outflow: d("pool_outflow")}'
curl -s "$API/pnl?by=index&value=20000&resolution=1d&start_timestamp=1767052800&end_timestamp=1767225600&count_back=0" | jq -c --arg day 2025-12-31T00:00:00Z "$DIFF"
sleep 1.1; curl -s "$API/pnl?by=index&value=1000&resolution=1d&start_timestamp=1735689600&end_timestamp=1767225600&count_back=0" > pnl-1000.json
for day in 2025-12-31 2025-10-12 2025-03-14; do jq -c --arg day "${day}T00:00:00Z" "$DIFF" pnl-1000.json; done
curl -s "$EXP/accounts/20000/logs?pub_data_type=L2TransferV2,BurnedShares,L2MintShares&limit=100" | jq -c '.[] | select(.time | startswith("2025-12-30")) | [.time[11:19], .pubdata_type, (.pubdata[] | .amount // .shares_to_burn_usdc), (.pubdata[] | .usdc_fee // null)]'
```

**L16.** Account 1000's withdrawal, its batch, and a hash with no log.

```sh
curl -s "$EXP/logs/00000000001782c02e00000130000000000000000000000000000000000000000000000000000000" | jq -c '[.tx_type, .time, .block_number, .batch_number, .status]'
sleep 2; curl -s "$EXP/batches/109274" | jq -c '[(.blocks | length), .blocks[0].block_number, .blocks[-1].block_number, (.blocks[0].block_number <= 137652420 and 137652420 <= .blocks[-1].block_number), .batch_details.execute_tx_hash[0:10], [.status_changes[] | [.batch_status, .updated_at]]]'
sleep 2; curl -s -w ' %{http_code}\n' "$EXP/logs/deadbeef"
```

**L17.** 7, 8, 9 and 10 days of `1h` up to now.

```sh
NOW=$(date -u +%s); for d in 7 8 9 10; do sleep 1.1; curl -s "$API/pnl?by=index&value=1000&resolution=1h&start_timestamp=$((NOW - d * 86400))&end_timestamp=$NOW&count_back=0" | jq -c --arg d "$d" '[$d, .code, (.pnl // [] | length)]'; done
```

**L18.** `probe` finds the first trade 313004 sent as taker at or after a time, in that day's S3 file, and asks `tx` for it. The edge was found by bisecting days from 2026-01-10 to 2026-11-10, then minutes on 2026-08-20.

```sh
probe() {
  T=$(( $(date -u -j -f %Y-%m-%dT%H:%M:%S "$1" +%s) * 1000 ))
  R=$(duckdb -noheader -list -c "select tx_hash || ' ' || timestamp from '$S3/trades/date=${1%T*}/trades.parquet' where ((ask_account_id = 313004 and not is_maker_ask) or (bid_account_id = 313004 and is_maker_ask)) and timestamp >= $T order by timestamp limit 1")
  sleep 1.1; echo "$(date -u -r $(( ${R#* } / 1000 )) +%FT%TZ) $(curl -s "$API/tx?by=hash&value=${R% *}" | jq -c '[.code, .block_height]')"
}
for t in 2026-11-10T00:00:00 2026-08-21T00:00:00 2026-08-20T04:00:00 2026-08-20T03:59:00 2026-06-01T00:00:00 2026-01-10T00:00:00; do probe "$t"; done
```

**L19.** The walk reads pages until one ends before 2026-11-14, as `lighter-account-logs` does. The last line prints entries since 2026-11-14, distinct entries, distinct hashes, and the types.

```sh
O=0; : > l19.jsonl
while :; do
  P=$(curl -s "$EXP/accounts/313004/logs?pub_data_type=$LEDGER_TYPES&limit=100&offset=$O")
  echo "$P" | jq -c '.[]' >> l19.jsonl
  [ "$(echo "$P" | jq length)" -lt 100 ] || [[ "$(echo "$P" | jq -r '.[-1].time')" < 2026-11-14 ]] && break
  O=$((O + 100)); sleep 6
done
echo "$((O / 100 + 1)) pages"
jq -s -c 'map(select(.time >= "2026-11-14")) | [length, (map(tojson) | unique | length), (map(.hash) | unique | length), (group_by(.pubdata_type) | map([.[0].pubdata_type, length]))]' l19.jsonl
```

**L20.** 693073's entries since 2026-11-16 fit in one page; 313004's come from L19. For each money move, `logs/{hash}` and its batch: each line counts the entries of a type in batches of a status, and how many of them sit in their batch's range with the log's `status` equal to the batch's.

```sh
curl -s "$EXP/accounts/693073/logs?pub_data_type=$LEDGER_TYPES&limit=100" | jq -c '.[]' > l20.jsonl
cat l19.jsonl l20.jsonl | jq -s -c 'map(select(.time >= "2026-11-16" and (.pubdata_type | IN("L1Deposit", "L1DepositV2", "Withdraw", "WithdrawV2", "L2Transfer", "L2TransferV2", "L2UpdateMargin", "L2MintShares", "BurnedShares", "L2StakeAssets", "UnstakeAssets", "ExecutedPendingUnlock", "ExitPosition", "ExitPositionWithFunding")))) | unique_by(.hash) | .[].hash' -r > l20-hashes.txt
while read -r h; do
  sleep 2; L=$(curl -s "$EXP/logs/$h")
  sleep 2; curl -s "$EXP/batches/$(echo "$L" | jq .batch_number)" | jq -c --argjson l "$L" '[$l.pubdata_type, .status_changes[-1].batch_status, (.blocks[0].block_number <= $l.block_number and $l.block_number <= .blocks[-1].block_number and $l.status == .status_changes[-1].batch_status)]'
done < l20-hashes.txt | jq -s -c 'group_by(.[0], .[1]) | map([.[0][0], .[0][1], length, (map(select(.[2])) | length)])'
```

The deposit in a `nothing_to_execute` batch: its log, then its batch, whether the batch's range holds its block, the execute hash, and the status changes.

```sh
L=$(curl -s "$EXP/logs/00000000001e620a3d00000130000000000000000000000000000000000000000000000000000000")
echo "$L" | jq -c '[.pubdata_type, .time, .block_number, .batch_number, .status]'
sleep 2; curl -s "$EXP/batches/$(echo "$L" | jq .batch_number)" | jq -c --argjson l "$L" '[.batch_number, (.blocks[0].block_number <= $l.block_number and $l.block_number <= .blocks[-1].block_number), .batch_details.execute_tx_hash, [.status_changes[] | [.batch_status, .updated_at]]]'
```

**L21.** The first part reads seven pool accounts 40 s before the next hour mark and 30 s after it, then that hour's `fundings` entry for each market they hold. Each account prints the hour, its index, its open positions, its `collateral` change, and the rule: the sum over positions of −signed position × `value` when `direction` is `long`, +signed position × `value` when `short`. Then its newest log entry, which must be older than the readings. The second part checks every prefix sum in L19's walk against the first one plus 10^8 × `value` per hour mark between, + for `long` and − for `short`; it prints distinct entries, entries that match, hour marks between the first and last, and `short` hour marks.

```sh
ACCOUNTS="281474976624925 281474976622846 281474976489165 281474976489166 281474976552443 281474976466894 281474976498676"
H=$(( ($(date -u +%s) / 3600 + 1) * 3600 ))
while [ "$(date -u +%s)" -lt $((H - 40)) ]; do sleep 1; done
for a in $ACCOUNTS; do curl -s "$API/account?by=index&value=$a" > "before-$a.json"; sleep 1.1; done
while [ "$(date -u +%s)" -lt $((H + 30)) ]; do sleep 1; done
for a in $ACCOUNTS; do curl -s "$API/account?by=index&value=$a" > "after-$a.json"; sleep 1.1; done
jq -r '.accounts[0].positions[] | select((.position | tonumber) != 0) | .market_id' before-*.json | sort -un > markets.txt
while read -r m; do sleep 1.1; curl -s "$API/fundings?market_id=$m&resolution=1h&start_timestamp=$(( (H - 3600) * 1000 ))&end_timestamp=$(( (H + 3600) * 1000 ))&count_back=0" | jq -c --argjson h "$H" --argjson m "$m" '.fundings[] | select(.timestamp == $h) | {market_id: $m, value, direction}'; done < markets.txt > fundings.jsonl
for a in $ACCOUNTS; do
  jq -n -c --slurpfile b "before-$a.json" --slurpfile a "after-$a.json" --slurpfile f fundings.jsonl --arg h "$(date -u -r "$H" +%H:%M)" '
    ($f | INDEX(.market_id | tostring)) as $fx
    | $b[0].accounts[0] as $x
    | [$x.positions[] | select((.position | tonumber) != 0) | (.sign * (.position | tonumber)) as $s | $fx[.market_id | tostring] | (if .direction == "long" then -$s else $s end) * (.value | tonumber)] as $amounts
    | [$h, $x.index, ($amounts | length),
       ((($a[0].accounts[0].collateral | tonumber) - ($x.collateral | tonumber)) * 1e6 | round / 1e6),
       (($amounts | add) * 1e6 | round / 1e6)]'
  sleep 6; curl -s "$EXP/accounts/$a/logs?limit=1" | jq -c '.[0] | [.time, .tx_type]'
done

curl -s "$API/fundings?market_id=0&resolution=1h&start_timestamp=1794528000000&end_timestamp=$(( $(date -u +%s) * 1000 ))&count_back=0" > eth-fundings.json
jq -n -c --slurpfile f eth-fundings.json '
  ($f[0].fundings | map({h: .timestamp, step: (((.value | tonumber) * 1e8 | round) * (if .direction == "long" then 1 else -1 end))})) as $steps
  | [inputs | select(.pubdata_type == "TradeWithFunding" and .pubdata.trade_pubdata_with_funding.market_index == 0) | {hash, s: (.time | sub("\\.[0-9]+"; "") | fromdate), p: .pubdata.trade_pubdata_with_funding.funding_rate_prefix_sum}]
  | unique_by(.hash) | sort_by(.s) | .[0] as $first | .[-1] as $last
  | [$steps[] | select(.h > $first.s and .h <= $last.s)] as $between
  | [length, (map(. as $x | select($x.p == $first.p + ([$between[] | select(.h <= $x.s) | .step] | add // 0))) | length), ($between | length), ($between | map(select(.step < 0)) | length)]' l19.jsonl
```

The script compares only `collateral`; check too that no position changes between the readings. At 13:00 two more pools with 54 and 63 positions matched within the rounding of `value`, and in all nine accounts each of the 131 positions with a non-zero term moved its `total_funding_paid_out` by that term, none by the opposite sign. On the 1000PEPE long, `value` 0.00000005 × 355200 = 0.01776 against the 0.016005 booked: the 8 decimals of `value` cannot price it closer.

**L22 to L27.** One entry of each pool, staking and margin type, found by walking 1000's and 693073's logs one type at a time. Each line prints the entry's type, time, block, batch and pubdata.

```sh
for h in ac1f7b9de3492e2bc9eac8adeefbce56c44cb7fb326afe02a26da977ec97d15e132c40179199544d \
  a2db9e6d3c6a2b10ebdeb425ed021563f8e91c220f06a71c2357137e359e54d7922ec02216954f94 \
  1b52d68691ad1b9dd2c7a3c32752ca5e72aeba98ca25cfa6d76e0c78f6bbc6a96a1bc8baca10440a \
  8ad8810ed23a49803127910a715083aca2008e5dc5f4f0d4ec25bd82bc39c177c845fe451c52c171 \
  0000001e8e683bff000001a107a120b0000000000000000000000000000000000000000000000000 \
  ae2ea19e23847b4063cc330bc56533ac113894bb8868d54dc537809d778c8649f1380d574631f03d; do
  sleep 2; curl -s "$EXP/logs/$h" | jq -c '[.pubdata_type, .time, .block_number, .batch_number, .pubdata]'
done
```
