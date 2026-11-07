# Coinbase Exchange market data: notes

These notes cover the endpoints in `vendor.yaml`. Every limit, field and value below comes from the Coinbase Exchange docs listed in `vendor.yaml` or from replies of `api.exchange.coinbase.com` on 2026-11-07. The proof table at the end ties the candle fields to one real candle for each product `coinbase-candles` loads.

## Candle fields

`GET /products/{product_id}/candles` sends each candle as an array of six numbers. `coinbase-candles` names them and turns `time` into `open_time` and `close_time` in Unix ms, in `raw.coinbase_candles`.

| At | Field | Meaning |
|---|---|---|
| 0 | `time` | The bucket's start, in Unix seconds. |
| 1 | `low` | The lowest trade price, in quote currency per base currency. |
| 2 | `high` | The highest trade price. |
| 3 | `open` | The price of the first trade in the bucket. |
| 4 | `close` | The price of the last trade in the bucket. |
| 5 | `volume` | How much of the base currency traded, in base-currency units. |

The order differs from Binance's: low comes before high, and open and close come after both. The page's summary line lists five fields, `[timestamp, price_low, price_high, price_open, price_close]`, but its list of response items and every reply have six, with volume last.

There is no quote volume and no trade count, so `token_prices` has null `quote_volume` and `trades` for Coinbase rows. The values are JSON numbers, not strings, such as `104.79995011`.

## Buckets and time

- `granularity` is the candle length in seconds: 60, 300, 900, 3600, 21600 or 86400. Anything else gets HTTP 400 `Unsupported granularity` (7200 was tried). `coinbase-candles` names them 1m, 5m, 15m, 1h, 6h and 1d, as Binance does.
- Buckets start on the Unix-epoch grid in UTC. 6h buckets start at 00:00, 06:00, 12:00 and 18:00, and 1d buckets at 00:00.
- `start` and `end` are both bucket starts, and both are inclusive. `start=10:00`, `end=12:00` at 3600 returned the 10:00, 11:00 and 12:00 candles. A `start` inside a bucket leaves that bucket out: `start=10:30`, `end=11:30` returned only 11:00. The docs warn that some candles "may precede your declared `start` value", but none did in these reads. `coinbase-candles` starts each window on a bucket start, ends it 1 ms before the next window, and drops any candle outside the window anyway.
- A reply holds at most 300 candles, counted as (`end` − `start`) / `granularity`. 00:00 to 05:00 at 60 s passed. 00:00 to 05:01 got HTTP 400 `granularity too small for the requested time range. Count of aggregations requested exceeds 300`. Coinbase refuses a range that is too long instead of cutting it short.
- Without both `start` and `end`, Coinbase ignores both. `start` alone returned the latest candles, 350 of them, not the 300 the page says.
- Replies come newest first. `coinbase-candles` sorts them oldest first.
- A bucket with no trades has no candle. UNI-USD at 60 s from 00:00 to 04:59 UTC on 2026-11-07 returned 263 candles for 300 buckets. The page also warns that "historical rate data may be incomplete", and a reply cannot tell a quiet minute from a missing one. Fill a gap only on purpose, with the last close and zero volume, and say so.
- A reply includes the bucket that is still open. At 20:01:17 UTC the newest 1h candle was the 20:00 one.

## Cached replies

Cloudflare serves the candle endpoint, and each reply carries `cache-control: public, max-age=300, must-revalidate`. The same URL asked again within 5 minutes can get the stored reply, whoever asked first.

That breaks the usual test for a closed candle. A candle that was open when the stored reply was made comes back with its partial values even after it closes. At 20:00:47 UTC, the 1h UNI-USD candle for 19:00 came back with `age: 50` and `cf-cache-status: HIT`, and volume 28365.735455: the candle as it was at 19:59:57, before its last trades. The same range with `end` written differently missed the cache and gave volume 28397.327917.

`coinbase-candles` sends the same URL for a window on every run, and keeps a candle once its end is before the time of the request. A run less than 5 minutes after one that saw the candle open can load the stale values as closed. The warehouse upserts by id and every run reads the whole range again, so the next run replaces them. Until it does, the last candle or so of a window can be short. To read a candle that has just closed, wait 5 minutes after its close, or check that the reply's `age` header is under the time since the close.

## Finding a product

- A market is a product: base currency, a hyphen, quote currency, such as `UNI-USD`. `GET /products/UNI-USD` returned status `online`, `trading_disabled` false, base currency `UNI` and quote currency `USD`. Status can also be `offline`, `internal` or `delisted`.
- An unknown product gets HTTP 404 with `{"message":"NotFound"}`, from `/products/{id}` and from its candles alike. `coinbase-candles` turns it into an error that names the token in `tokens.json`.
- The API names a currency only by Coinbase's ticker, never by chain or contract address. A candle says nothing about which on-chain token it prices, so joining one to `analytics.tokens` or a transfer takes a mapping that you choose and write down.
- The quote currency sets the unit. UNI-USD prices UNI in US dollars. Binance quotes the same tokens in USDT (see `catalog/vendors/binance/`), a token, so the two exchanges' rows differ in unit as well as venue.

## Limits

- Public endpoints allow 10 requests a second per IP, in bursts up to 15. Coinbase counts them with a token bucket that holds 15 and refills at 10 a second, and answers HTTP 429 when it is empty.
- No reply carries the count used. A client has to pace itself. `coinbase-candles` sends one chunk of at most `COINBASE_MAX_CONCURRENCY` (10 at most) requests a second, and sends a request that gets a 429 again after 1 s and then 2 s.
- The page asks clients not to poll historical rates often and to use the trades endpoint and the WebSocket feed for live data.

## Traps

- Read the columns by name, not by position from Binance's order. Coinbase sends low, high, open, close.
- A missing candle is not a zero. Count candles against buckets before you average or sum over a window.
- `volume` is in the base currency. With no `quote_volume`, a dollar volume needs `volume` × a price, and `close` is not the bucket's average price.

## Proof table

Each candle was read from `GET /products/{product_id}/candles?granularity=3600` on 2026-11-07 after its hour had closed, and rebuilt from `GET /products/{product_id}/trades`, paging back with the `CB-AFTER` cursor until the hour was covered. The rebuild takes the trades whose time falls in the hour and orders them by `trade_id`. `open` is the first one's price, `close` the last one's, `high` and `low` the most and least, and `volume` = Σ `size`. Every field matched the candle, in decimal arithmetic. The trade ids in each hour have no gaps.

All three are 1h candles with `time` 1794074400 (2026-11-07T18:00Z).

| # | Product | `low` | `high` | `open` | `close` | `volume` | Trades | Trade ids |
|---|---|---|---|---|---|---|---|---|
| 1 | UNI-USD | 7.0976 | 7.2115 | 7.1 | 7.195 | 53080.720652 | 2229 | 80028356–80030584 |
| 2 | ETH-USD | 2232.28 | 2236.57 | 2232.66 | 2233.7 | 1524.38968912 | 6799 | 853017081–853023879 |
| 3 | BTC-USD | 75664.16 | 75789.4 | 75735.08 | 75684.4 | 104.79995011 | 17199 | 1116827418–1116844616 |

The same rebuild on the 19:00 hour, started at 19:59:57 before that hour closed, did not match. The candle read then had volume 28365.735455, while the trades up to 19:59:51 already summed to 28377.348679, so even a reply from the origin can trail the trades by a few seconds. That read is the one Cloudflare stored and served again at 20:00:47 (see Cached replies).
