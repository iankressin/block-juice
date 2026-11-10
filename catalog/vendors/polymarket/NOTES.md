# Polymarket market data: notes

These notes cover the endpoints in `vendor.yaml`. Every limit, field and value below comes from Polymarket's docs (listed there) or from replies of `gamma-api.polymarket.com`, `clob.polymarket.com` and `data-api.polymarket.com` on 2026-11-07 (replies are dated 2026-11-08 UTC). The proof table at the end ties the fields to the markets that `catalog/protocols/polymarket/` proves on chain. All requests went through the proxy that this machine needs for Polymarket's hosts.

## Which endpoint lists markets

- `GET /markets/keyset` is the list. The older `GET /markets` is deprecated: each reply carried `deprecation: true`, `sunset: Fri, 01 May 2026 00:00:00 GMT` and `warning: 299 - "use /markets/keyset"`. It still answered HTTP 200 on 2026-11-07, with a bare array.
- The old list refuses a deep `offset`. Binary search on `GET /markets?limit=1&offset=N` found HTTP 200 up to 2000 and HTTP 422 from 2001, with `{"type":"validation error","error":"offset too large, use /markets/keyset for deeper pagination"}`.
- The keyset list refuses `offset` at all: `?limit=1&offset=5` gave HTTP 422 `{"type":"validation error","error":"offset is not allowed on keyset endpoints"}`.

## Paging

- A reply is `{"$schema": …, "markets": [ … ], "next_cursor": "…"}`. A full page holds `limit` markets and a `next_cursor`. Send it back as `after_cursor`. The last page has fewer markets and no `next_cursor`: the open-market scan below ended on a page of 56 markets with no cursor.
- `limit` defaults to 20 and the docs give 100 as the most. `limit=500` and `limit=1000` each returned exactly 100 markets with no error, and the bodies had the same size as `limit=100`.
- The cursor is URL-safe base64. Its text part holds the last id and a hash of the filters: `{"v":1,"k":"markets","oh":"4f53…","keys":[{"t":"string","v":"561270"}]}`. Treat it as opaque. It binds to the filters of the first request, so keep them the same on every page.
- There is no count and no total anywhere in the reply or in the Gamma spec. Counting takes a full walk, or a sample (below).
- Replies are cached for 5 minutes (`cache-control: public, max-age=300`, `x-cache: Hit from cloudfront`, `age: 174` on one). A page can be that old.
- A page of 100 markets is about 560 KB, mostly the `description` text and the nested `events`.
- Order: without `order`, markets come in ascending numeric id (`['12', '17', '18', …]` for `closed=true`; `559651, 559652, …` for the default). Ids are strings in the JSON but sort as numbers. `order=id&ascending=false` gave `6830655` first. A new market gets a higher id, so a cursor in ascending order picks up new markets at the end.

## The `closed` filter

- The default is `closed=false`: `GET /markets/keyset?limit=100` returned only markets with `closed` false, from id 559651. `closed=true` returned only closed markets, from id 12.
- A full run needs two walks, one for each value. `closed=any` is for lookups: with no id filter it gets HTTP 422 `closed=any requires at least one of id, slug, clob_token_ids, position_ids, condition_ids, request_ids, onchain_event_ids, or question_ids`.
- A market that has just closed leaves the open list and enters the closed one. A market that traded in the last month is mostly closed now: the 5-minute crypto markets close within minutes (proof rows 2 and 9 below are both closed).

## The `version` filter and Protocol V2 markets

- `version` is a filter on `/markets/keyset`. Values: `v1` and `v2`. Anything else is HTTP 422 `{"type":"validation error","error":"expected value to be one of \"v1, v2\""}` (`version=v3` and `version=V2` both got it).
- Without `version`, a list returns only `v1` markets. Open walk with no `version`: 2,108 pages, 210,756 markets, none `v2`. `closed=true&limit=100` returned 100 `v1` markets from id 12. `version=v1&closed=false` returned 100 `v1` from id 559651.
- `version=v2` lists V2 markets: `limit=100&version=v2&closed=true` returned 100 markets, all `v2`, from id 5662873 (`createdAt` 2026-10-13T17:30:52Z). `limit=100&version=v2&closed=false` returned 100, all `v2`, from id 6255194 (`createdAt` 2026-10-26T16:00:00Z). So the first V2 market is id 5662873, created 2026-10-13T17:30:52Z (lowest id of the two first pages; both lists sort by ascending id).
- A walk of `version=v2&closed=false`: 55 pages, 5,446 markets, 72 s. All `v2`; condition ids start `0x01` on 4,776 (binary module) and `0x02` on 670 (neg-risk module); `negRisk` is true on 670, false on 4,018 and absent on 758; ids 6255194 to 6831390, created 2026-10-26T16:00:00Z to 2026-11-08T02:31:33Z.
- A walk of `version=v2&closed=true`: 537 pages, 53,636 markets, 634 s (10.6 min, run beside the open walk). All `v2`; condition ids start `0x01` on 51,703 and `0x02` on 1,933; `negRisk` true on 1,933, false on 39,512, absent on 12,191; ids 5662873 to 6819513, created 2026-10-13T17:30:52Z to 2026-11-07T22:35:14Z. So V2 holds 59,082 markets in all (5,446 open, 53,636 closed), and one full V2 run is about 12 minutes sequential.
- An id lookup does not need `version`: `id=6770019`, `condition_ids=0x0120…0000&closed=any`, `clob_token_ids` and `position_ids` each returned the V2 market 6770019 with no `version`. `id=6770019&version=v1` returned `markets: []`.
- A keyset `slug` lookup does need it. `slug=polyv2zec-updown-5m-1794110100` (also with `closed=any`) returned `markets: []`; with `version=v2` it returned market 6770019. A V1 slug (`slug=xi-jinping-out-before-2027`) works with no `version`. `GET /markets/slug/{slug}` also returned 6770019 with no parameter, and is the slug lookup to use.
- Earlier windows (kept as evidence that the default hides V2): `closed=false&end_date_min=2026-11-08T03:59:00Z&end_date_max=2026-11-08T04:01:00Z` returned 278 `v1` markets, none with id 6770019 (open, `v2`, ends 04:00:00Z). `closed=true&end_date_min=2026-11-07T07:59:00Z&end_date_max=2026-11-07T08:01:00Z` returned 128 `v1` markets in two pages (page 1 held 100 with a `next_cursor`; I walked page 2, 28 markets, no cursor), none with id 6770016 (`v2`, ends 08:00:00Z). The same closed window with `version=v2` returned 12 `v2` markets.
- A sample of 83 windows of 100 consecutive ids found 360 V2 markets (353 closed, 7 open), all with a `polyv2` slug; an earlier guess that they began on 2026-10-22 was wrong, the first by id is the one above.

## How long a full run takes

- One page takes about 1 s through the proxy (`limit=1` also took 0.9 s), so a sequential walk runs at about 0.8 pages a second. The limits (300 requests per 10 s on `/markets`) are far above that, and six parallel walks ran at 4.7 pages a second with no 429.
- Open markets (`closed=false`): 210,756 markets, 2,108 pages, 2,554 s (43 min) in one sequential walk on 2026-11-07. Their ids run from 559651 to 6830601. 75,081 have `negRisk` true. All have `version` `v1`. 44 have an empty `conditionId` and a null `clobTokenIds` (placeholder neg-risk markets, ids from 2290078). 210,712 distinct condition ids.
- All markets: ids run from 12 to 6.83 million. Windows of 100 consecutive ids held 97 to 100 markets above id 2,000,000, so the list holds roughly 6 million markets (an estimate from nine windows). That is about 60,000 pages and 20 hours for a sequential walk, far over 10 minutes. I did not walk it.
- Closed markets that ended in the window and have volume: `closed=true&volume_num_min=0.000001&end_date_min=<day>&end_date_max=<next day>` for each day from 2026-10-01 to 2026-11-08, six days in parallel, gave 475,600 markets in 4,777 pages and 1,018 s (17 min).
- `end_date_min` and `end_date_max` both include their bound, so day windows that share a midnight overlap on it and lose no market (re-run on 2026-11-08 through the proxy). `closed=true&version=v1&limit=100&end_date_min=2026-10-20T00:00:00Z&end_date_max=2026-10-20T00:00:01Z` returned HTTP 200 with 100 markets, all with `endDate` `2026-10-20T00:00:00Z`, and a cursor. `end_date_min=2026-10-19T23:59:59Z&end_date_max=2026-10-20T00:00:00Z` returned the same: 100 markets with that `endDate`, and a cursor. A zero-width window (min = max) gets HTTP 422 `{"type":"validation error","error":"error validating query argument \"end_date\": invalid time range"}`. A market that ends at midnight lands in two day windows, and a record upserts by id.
- `volume_num_min` cuts little. On the 10,438 closed markets that ended on 2026-10-20, `volume_num_min=0` and `0.000001` both gave 10,438, `1` gave 9,947 (95%), `100` gave 6,643 (64%) and `1000` gave 3,600 (34%). Windows of 100 consecutive ids held far fewer markets with a non-zero `volumeNum` (0 to 12 in the windows from id 6,000,000), so the filter and the field do not match; I did not find out why.
- `end_date_min` and `end_date_max` split a walk into windows that can run side by side, and a minimum on `endDate` drops the old closed markets. The first closed market by id with `end_date_min=2026-10-01T00:00:00Z` was id 549868, with `endDate` 2026-12-31: a far end date does not mean a recent market. For a source that must cover trades since 2026-10-01, the open walk (43 min sequential) plus the closed day windows (17 min with six in parallel) is the measured cost; the windows lose a market whose `endDate` falls before the first trade it took.

- The reply to too many requests is an open item. I did not provoke a 429, because the proxy's IP is shared. The rate-limits page says requests are throttled (delayed), not rejected. Retry 429 and 5xx with backoff.

## Fields that `stg_polymarket__markets` reads

Types come from 796 markets sampled in windows of 100 consecutive ids across the id range, plus the 210,756 open markets and 360 V2 markets.

| Field | JSON type | Notes |
|---|---|---|
| `id` | string | `"6764951"`. Not a number. |
| `conditionId` | string | `0x` and 64 hex digits, lowercase. Empty on 44 open placeholders. |
| `questionID` | string | Absent on V2 markets. |
| `question`, `slug` | string | |
| `outcomes` | string | JSON-encoded: `"[\"Up\", \"Down\"]"`. Two entries on all 796 sampled. |
| `outcomePrices` | string | JSON-encoded decimal strings: `"[\"0\", \"1\"]"`. |
| `clobTokenIds` | string, or null | JSON-encoded decimal strings, same order as `outcomes`. Null on the 44 placeholders. |
| `positionIds` | array of strings | Absent on 321 of 796. |
| `negRisk` | boolean | Absent on 26 open markets and on 65 of 360 V2 markets. |
| `negRiskMarketID` | string | On a V1 neg-risk market it is the NegRiskAdapter market id. Absent on others and on V2 neg-risk markets. |
| `version` | string | `v1` or `v2`. |
| `startDate`, `endDate`, `createdAt`, `updatedAt` | string | ISO 8601, `Z`. `startDate` and `endDate` have seconds or fractions of a second; `createdAt` and `updatedAt` have microseconds. |
| `closed` | boolean | |
| `closedTime` | string | Absent while open. `"2026-10-15 12:00:53+00"` once closed: a space, and `+00` as offset. |
| `events` | array | One element on all 796. `events[0]` has `id`, `slug`, `title`, `negRisk`. |

- `outcomes` and `clobTokenIds` are strings that hold JSON. Parse them. The docs say the same ("Outcome labels and prices are JSON-encoded strings", parse `clobTokenIds` for CTF).
- Token ids are decimal strings below 2^256. Keep them as text or `numeric`, not `bigint` or a JSON number.
- `outcomes[i]` goes with `clobTokenIds[i]` (proof rows 1 to 3).
- Outcome count: all 796 sampled markets, 210,712 open markets (by `clobTokenIds` length) and 360 sampled V2 markets had 2 outcomes. I found no market with more than two; a lookup for one was not attempted.
- The market object has about 100 fields; the staging model needs 18 of them.

## Which protocol, and which ids

- `version` names the protocol: `v1` for CTF markets, `v2` for Protocol V2. The docs: "Use `market.version` to select the identifiers … Both fields can be populated, so their presence does not select the protocol." Treat other values as unknown.
- V1 markets: the trading token ids are `clobTokenIds`, which are ConditionalTokens position ids (proof rows 1 to 3). Many V1 markets also carry `positionIds` (474 of 795 sampled). Those never equalled `clobTokenIds` (474 of 474) and their hex form ends in `…0000`, `…0001`, `…0200`, `…0201`. They are the ids of the market's Protocol V2 twin, the position that migrating `clobTokenIds[i]` mints: `positionIds[i]` goes with `clobTokenIds[i]` (`catalog/protocols/polymarket/NOTES.md`, Q10, proof rows 36 and 40). Do not use them as the V1 market's trading tokens.
- V2 markets: `positionIds` equals `clobTokenIds` on all 360 (`"clobTokenIds": ["8453…0608", "8453…0609"]`). The id is `conditionId` with the outcome index in the last byte: `clobTokenIds[0]` = `0x01de77a1…0000` = the `conditionId`, `clobTokenIds[1]` = the same with `…01`. The top byte of `conditionId` is the module: `0x01` binary (330 of 360), `0x02` neg risk (30 of 360).
- The V2 `conditionId` is not a ConditionalTokens condition id. It ends in zero bytes (`0x01de77a1eabef176b40e662f3aaa0f0240000000000000000000000000000000`). It is the condition id the V2 modules emit (a `bytes31` topic with its zero 32nd byte), and the Protocol V2 Exchange's `OrderFilled.tokenId` equals `clobTokenIds[i]` (`catalog/protocols/polymarket/NOTES.md`, Q11, proof rows 26, 28 and 31).
- Gamma's V2 list starts at its first V2 market (2026-10-13), but native V2 binary markets traded on chain from 2026-09-15. Samples of those early fills found 17 conditions with no Gamma row under `condition_ids`, `clob_token_ids` or `position_ids` (`catalog/protocols/polymarket/NOTES.md`, "Three kinds of V2 market", proof row 43).
- Gamma lists no parlay (combinatorial, `0x03…`) market: `clob_token_ids`, `position_ids` and `condition_ids` lookups of a traded parlay returned `markets: []` on 2026-11-08.
- Gamma creates a neg-risk question before the NegRiskAdapter prepares it on chain. Of the 66,688 `QuestionPrepared` logs from block 96526194 to 97032704 (2026-11-01 to 2026-11-09) whose `questionId` Gamma lists, none came before the Gamma market's `createdAt`. The chain came 2 s to 5 min 53 s later, 12 s at the median and 86 s at the 99th percentile. So a question Gamma created after a block was prepared after it too. Gamma's current list also holds questions prepared after any fixed window.

## Outcome order and winners

- `outcomes[i]` goes with `clobTokenIds[i]` and `outcomePrices[i]`. For proof rows 1 to 3 `clobTokenIds[0]` equals the ConditionalTokens position id for index set 1 and `clobTokenIds[1]` the one for index set 2, as Task 1 computed on chain.
- A settled market shows `closed` true and `outcomePrices` `["1", "0"]` or `["0", "1"]`; the 1 marks the winner. The payout vector on chain (`payoutNumerators`) agrees in rows 1 and 3. A market that is open shows its price (row 2: `["0.0005", "0.9995"]`).
- `umaResolutionStatuses` was `"[]"` on the three proof markets. It does not say that a market settled.

## Cross-check endpoints

### CLOB `prices-history`

`GET https://clob.polymarket.com/prices-history?market=<token id>&startTs=<s>&endTs=<s>&fidelity=1` for the Up token of proof row 1 (`…0327`), `startTs=1794094200`, `endTs=1794094800`, returned 10 points, from `{"t":1794094243,"p":0.5}` to `{"t":1794094760,"p":0.025}`:

```
{"history":[{"t":1794094243,"p":0.5},{"t":1794094281,"p":0.5},{"t":1794094346,"p":0.495}, … ,{"t":1794094699,"p":0.175},{"t":1794094760,"p":0.025}]}
```

`t` is an integer in Unix seconds. `p` is a number. The reply is not a trade list: 10 points in a 10-minute window with `fidelity=1`, so it is sampled. Compare it to candles by rounding, not exactly. `cache-control: public, max-age=90`.

### Data API `v2/positions`

`GET https://data-api.polymarket.com/v2/positions?user=<proxy wallet>&condition=<condition id>&status=CLOSED` for the maker `0x3bfcd24e…a199` of proof row 1 returned one position for the Down token: `avg_price` 0.51, `total_size` 8.71, `realized_pnl` 4.2679, `current_price` 1.0, `outcome` `Down`, `outcome_index` 1. That equals the on-chain buy of 8,710,000 shares for 4,442,100 (Task 1, proof row 2): 8.71 − 4.4421 = 4.2679. With the default `status` (`OPEN`) the same query gave an empty `data`.

The market anchor lists holders: `?condition=0xb901…27cd&limit=2` (the neg-risk market, row 2 below) returned two wallets, each with `current_size`, `current_price` 0.9995 and `unrealized_pnl`.

The reply is `{"data": [ … ], "pagination": {"limit": 100, "offset": 0, "has_more": false, "next_cursor": null}}`. Numbers are JSON numbers in USDC and shares, not base units.

## Traps

- `/markets/keyset` returns only V1 markets unless you send `version=v2`. A source needs one walk per `version` (and per `closed` value).
- The default `closed=false` leaves out every closed market, and most markets that traded in a month are closed.
- `limit` above 100 is cut without a message. Count the rows, not the request.
- `clobTokenIds` is null and `conditionId` is empty on placeholder markets. Drop them before a cast.

## Proof table

All rows come from `GET /markets/keyset?closed=any&condition_ids=<condition id>` (or `id=` for row 4, `position_ids=` for rows 4 and 5) on 2026-11-07. The token ids are `clobTokenIds[0]` then `clobTokenIds[1]`.

| # | Market | Gamma id | `conditionId` | `clobTokenIds[0]` (`outcomes[0]`) | `clobTokenIds[1]` (`outcomes[1]`) | State |
|---|---|---|---|---|---|---|
| 1 | Ethereum Up or Down, Nov 7 6:35–6:40PM ET (CTF binary; Task 1 proof row 2) | 6764951 | `0xcf28ea01af1aedbbb96bb3f2ed8efd5b4c52faaf057c98e59b118b75cc0afc6a` | `56491295322642479574009649190264906678337478953962544953766149611910922990327` (Up) | `103688884060883873727013522652996002941410548793093120456496990699655719191268` (Down) | `version` v1, `negRisk` false, `closed` true, `outcomePrices` `["0", "1"]`, `closedTime` `2026-11-07 23:41:19+00`, `questionID` `0x0c95a003c0921e6997e6c2fdfa0303dd6b0df6f2a997755d514b606a19d396c8` |
| 2 | Beijing high temperature 3°C or below, Nov 8 (neg risk; Task 1 proof row 8) | 6740832 | `0xb901c2288f5e1400581967ab8c0ed886857fe6c8af0f28a69fea5920676927cd` | `41391445723290947929903824132236677981734625609614562856315843204007756160788` (Yes) | `25549256560926861618697622075876655971438451490681750134163329000025902954439` (No) | `version` v1, `negRisk` true, `negRiskMarketID` `0x7d0bd97d337485c07cd88ba4472550d70754736175642907c3bf2834b8bff000` (`questionID` and `events[0].negRiskMarketID` hold the same value), `closed` false, `outcomePrices` `["0.0005", "0.9995"]`, event 1323603 |
| 3 | BNB Up or Down, Oct 15 4–8AM ET (CTF binary, resolved; Task 1 proof row 9) | 5681656 | `0x21a77299dec1537c744abdbcb382c9e6b9d2386b8a495948f5745a336e8bade3` | `32210257784509415691320375334453862893439494594095949869273938405916136875301` (Up) | `48755770820822725373265860999466965557820888962974715213812255943121114346082` (Down) | `version` v1, `negRisk` false, `closed` true, `outcomePrices` `["1", "0"]`, `closedTime` `2026-10-15 12:00:53+00`, `questionID` `0x3eb8976c590698d977b3708eaeeba997a5220b8f5e0454422ffaaef26dcac854` |
| 4 | Zcash Up or Down, Nov 1 6:40PM–6:45PM ET (Protocol V2 binary) | 6500010 | `0x01de77a1eabef176b40e662f3aaa0f0240000000000000000000000000000000` | `845378570052374931981304372340332689146676392903044049134757485097263300608` (Up) | `845378570052374931981304372340332689146676392903044049134757485097263300609` (Down) | `version` v2, `closed` true, `outcomePrices` `["0", "1"]`, `positionIds` = `clobTokenIds`, no `questionID`, no `negRisk`, slug `polyv2zec-updown-5m-1793576400`, created 2026-10-31T23:40Z |
| 5 | Miami highest temperature 75°F or below, Nov 6 (Protocol V2 neg risk) | 6670070 | `0x02ae78d780d7d64586bd02c23aa2a161a4010000000000000000000000000000` | `1212891105956883479832790072668483099572529148867447370689757672319729270784` (Yes) | `1212891105956883479832790072668483099572529148867447370689757672319729270785` (No) | `version` v2, `negRisk` true, no `negRiskMarketID`, `closed` true, `outcomePrices` `["0", "1"]`, `positionIds` = `clobTokenIds`, event 1312596 |

What the rows show:

- Rows 1 to 3 give the same two token ids per condition that Task 1 computed from ConditionalTokens (`getPositionId` at index sets 1 and 2): `clobTokenIds[0]` is the index set 1 token, `clobTokenIds[1]` the index set 2 token. All six ids match in full.
- Row 1 pays `[0, 1]` on chain and Gamma shows `["0", "1"]`: Down wins. Row 3 pays `[1, 0]` and Gamma shows `["1", "0"]`: Up wins. Row 3's `closedTime` (12:00:53 UTC) equals the `ConditionResolution` block time. Row 2 is open on both sides.
- Row 4: `0x01de77a1…` as hex is `clobTokenIds[0]` with the last byte 00 and `clobTokenIds[1]` with 01. Row 5 follows the same rule with top byte `0x02`. These are the position ids that the Protocol V2 contracts and `OrderFilled` use: the protocol entry's Q11 proves it on fills of markets 5931602, 5931605 and 6015111.
- The other V2 market looked up above (`6770019`, open, condition `0x012022213b0b69c791e46cd2665350ea69000000000000000000000000000000`) shows the same shape: `clobTokenIds[0]` `509087509928325909252543985009258432142384070580348294089705821985333837824`, `[1]` the same plus 1.
