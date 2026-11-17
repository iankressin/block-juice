-- One Lighter candle per market, price series and bucket. price is trade or mark. open_time is the
-- bucket start. Prices are USDC per base unit; base_volume is in base units and quote_volume in USDC.
-- Only trade candles carry volume and last_trade_id, and only mark candles carry samples.
select
    market_id,
    symbol,
    price,
    resolution,
    open_time,
    open,
    high,
    low,
    close,
    base_volume,
    quote_volume,
    last_trade_id,
    samples
from {{ ref('stg_lighter__candles') }}
