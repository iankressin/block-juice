# Binance spot market data: notes

These notes cover the endpoints in `vendor.yaml`. Every limit, field and value below comes from the Binance API docs listed in `vendor.yaml` or from replies of `data-api.binance.vision` on 2026-11-07. The proof table at the end ties the candle fields to one real candle for each market `binance-candles` loads.

## Candle fields

`GET /api/v3/klines` sends each candle as an array. `binance-candles` names the positions and keeps every value as Binance sends it, in `raw.binance_candles`.

| At | Field | Meaning |
|---|---|---|
| 0 | `open_time` | When the candle opens, in Unix ms. With the market and interval it identifies the candle. |
| 1 | `open` | The price of the first trade, in quote asset per base asset. |
| 2 | `high` | The highest trade price. |
| 3 | `low` | The lowest trade price. |
| 4 | `close` | The price of the last trade. While the candle is open, the latest trade so far. |
| 5 | `volume` | How much of the base asset traded, in base-asset units. |
| 6 | `close_time` | The candle's last millisecond: `open_time` + the interval − 1 ms. Every 1h candle in the proof table has 3599999 ms between the two. |
| 7 | `quote_volume` | Each trade's price × quantity, summed, in quote-asset units. It is not `volume` × `close`. |
| 8 | `trades` | How many trades, counted by trade id. An aggregate trade from `aggTrades` can hold several. |
| 9 | `taker_buy_base_volume` | The base volume of trades where the taker bought: in `aggTrades`, the rows with `m` (buyer is maker) false. |
| 10 | `taker_buy_quote_volume` | The quote volume of those trades. |
| 11 | ignore | Binance labels it "Ignore". It was `"0"` in every reply. |

Prices and volumes are decimal strings with 8 decimals, such as `"7.10700000"`. Read them as `numeric`, never as floating point. `stg_binance__candles` does that.

## Candles and time

- Binance cuts candles in UTC unless the request sends `timeZone`, and `startTime` and `endTime` are always UTC.
- Candles from 1m to 1d start on the Unix-epoch grid. 3d candles do too: the 3d candle after 2026-11-04 opened at 2026-11-06T00:00Z, a whole number of 3-day spans after 1970-01-01. 1w candles do not. They open on Mondays at 00:00 UTC (2026-10-26, 2026-11-02), and 1970-01-01 was a Thursday. 1M candles are calendar months, so they have no fixed length.
- A reply holds only candles that open at or after `startTime`. With `startTime` on Wednesday 2026-11-04, `1w` returned no candle, because that week's candle opened on the Monday and the next had not opened yet, and `3d` returned the candle that opened on 2026-11-06. A window that starts inside a candle loses that candle. So `binance-candles` first asks for one candle from `START_TIME` and starts the market's windows at its `open_time`.
- Before a market lists, `startTime` returns its first candle. `startTime=0` gave UNIUSDT's first 1h candle, opening at 1600311600000 (2020-09-17T03:00Z) with open 0.3 and high 15. Prices in a market's first hours can be far from the rest of its history.
- A reply can end with the candle that is still open. At 2026-11-07T19:58:38Z the last 1h UNIUSDT candle had `close_time` 1794081599999, a minute in the future. Its close and volume changed between two reads: `"7.14500000"` and `"97068.67000000"` at 19:57:10, then `"7.14200000"` and `"99403.96000000"` at 19:58:38. Keep only candles whose `close_time` is before the time you sent the request. `binance-candles` does that, and the next run loads the candle once it has closed.
- Binance caches nothing for a client. Every reply carried `cache-control: no-cache, no-store, must-revalidate`, and the open candle's values changed between reads.

## Finding a market

- A market is called a symbol: the base asset, then the quote asset, with nothing between, such as `UNIUSDT`. `GET /api/v3/exchangeInfo?symbol=UNIUSDT` returned status `TRADING`, base asset `UNI` and quote asset `USDT`.
- An unknown symbol gets HTTP 400 with `{"code":-1121,"msg":"Invalid symbol."}` from `klines` and from `exchangeInfo`. `binance-candles` turns it into an error that names the token in `tokens.json`.
- The API names an asset only by Binance's ticker, never by chain or contract address. A candle says nothing about which on-chain token it prices, so joining one to `analytics.tokens` or a transfer takes a mapping that you choose and write down.
- The quote asset sets the unit. UNIUSDT prices UNI in USDT, a token, not in US dollars. Coinbase quotes the same tokens in USD (see `catalog/vendors/coinbase/`). Rows from the two exchanges have different units until something converts USDT to USD.

## Limits

- Binance allows 6000 request weight a minute per IP. `klines` weighs 2, `aggTrades` 4 and `exchangeInfo` 20.
- The count is the IP's, not the client's. Two `klines` calls one after the other from this session read 30 and then 234 in `x-mbx-used-weight-1m`, because other clients shared the IP. Read the header after each reply rather than counting your own requests. `binance-candles` does that.
- Over the limit, Binance answers HTTP 429 with `Retry-After` in seconds. An IP that keeps sending is banned with HTTP 418, for 2 minutes to 3 days, and longer for repeat offenders. A ban is the only error that stops a `binance-candles` run, since more requests lengthen it.
- `limit` above 1000 is cut to 1000, not refused: `limit=1001` returned 1000 candles. A client that asks for more and expects an error gets a short reply instead.

## Traps

- `quote_volume` / `volume` is the volume-weighted average price of the candle, not `close`. Use it for a VWAP, and `close` for a price at a moment.
- `trades` counts trades, not rows of `aggTrades`. In proof row 1, 5182 trades came in 2144 aggregate trades.
- A candle is Binance's market only. UNIUSDT's listing hour printed a high of 15 against an open of 0.3. Compare a candle's extreme with Coinbase or an oracle (`analytics.oracle_prices`) before you report it as the token's price.

## Proof table

Each candle was read from `GET /api/v3/klines` on `data-api.binance.vision` on 2026-11-07 and rebuilt from `GET /api/v3/aggTrades` over the same hour: `startTime` = `open_time` and `endTime` = `close_time`, then paging by `fromId`. The rebuild takes `open` = the first trade's price, `close` = the last one's, `high` and `low` = the most and least, `volume` = Σ `q`, `quote_volume` = Σ `p` × `q`, `trades` = Σ (`l` − `f` + 1), and the taker-buy volumes as the same sums over rows with `m` false. Every field matched the candle exactly, in decimal arithmetic. A second read of each candle, minutes later, returned the same values.

All three are 1h candles with `open_time` 1794074400000 (2026-11-07T18:00Z) and `close_time` 1794077999999.

| # | Symbol | `open` | `high` | `low` | `close` | `volume` | `quote_volume` | `trades` | `taker_buy_base_volume` | `taker_buy_quote_volume` | Trade ids | Aggregate trades |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | UNIUSDT | 7.10700000 | 7.21600000 | 7.10700000 | 7.20700000 | 194057.54000000 | 1389097.15368000 | 5182 | 115819.48000000 | 829248.68986000 | 304904814–304909995 | 2144 |
| 2 | ETHUSDT | 2236.02000000 | 2239.71000000 | 2235.75000000 | 2237.26000000 | 1930.16010000 | 4318817.65536500 | 12243 | 1199.90900000 | 2684890.51605200 | 4492768401–4492780643 | 4275 |
| 3 | BTCUSDT | 75847.41000000 | 75891.52000000 | 75801.94000000 | 75802.58000000 | 86.38646000 | 6551796.67225230 | 16739 | 35.83628000 | 2717906.36565950 | 6829839578–6829856316 | 8982 |
