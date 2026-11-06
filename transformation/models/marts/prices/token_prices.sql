-- One candle of one token against one quote asset at one interval, from Binance.
-- Prices are in quote-asset units: a UNI row with quote USDT gives UNI's price in USDT.
-- volume is in token units, quote_volume in quote-asset units.
select
    base_asset as token,
    quote_asset as quote,
    interval,
    open_time,
    close_time,
    open,
    high,
    low,
    close,
    volume,
    quote_volume,
    trades
from {{ ref('stg_binance__candles') }}
