# Lighter market data: notes

These notes cover the hosts, endpoints and S3 files in `vendor.yaml`. Every limit, field and value below comes from the Lighter docs that `vendor.yaml` lists, or from replies of `mainnet.zklighter.elliot.ai`, `explorer.elliot.ai` and the public S3 bucket on 2026-11-17. The proof table at the end gives the command that rebuilds each fact.

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

- `GET /api/v1/tx?by=hash&value=<tx_hash>` returns `block_height`. For trade 40627877458's hash (`5b112217…95d2`) it was 389272097, equal to the API trade's `block_height` and S3's `l2_block_height`, with `type` 14.
- Explorer `GET /logs/{hash}` returns `block_number` and, once batched, `batch_number`: 389272097 and 268847 for the same hash, with `tx_type` `L2CreateOrder` and the trade's pubdata.
- Explorer account-log entries (`GET /accounts/{param}/logs?limit=&offset=`) carry `hash`, `pubdata`, `pubdata_type`, `status`, `time` and `tx_type`, and no block number. They page newest first by `offset`.
- A batch is a contiguous block range. Batch 268847 holds blocks 389271230 to 389272829, 1,600 blocks, among them 389272097; batch 99999 ends at 125735108 and batch 100000 starts at 125735109. Batch sizes vary: batches 99999, 100000, 200000 and 250000 hold 1,600 blocks and batch 50000 holds 305; `GET /batches` gave `batch_size` 1600 for the 20 most recent. The Explorer finds no batch 1, 2 or 10000.

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
