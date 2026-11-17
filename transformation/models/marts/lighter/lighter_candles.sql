-- One Lighter candle per market, price series and bucket. price is trade or mark. open_time is the
-- bucket start. Prices are USDC per base unit; base_volume is in base units and quote_volume in USDC.
-- Only trade candles carry volume and last_trade_id, and only mark candles carry samples. Lighter
-- leaves a zero field out of a trade candle, so a missing volume or trade id there is 0; a mark
-- candle's stay null.
select
    id,
    market_id,
    symbol,
    price,
    resolution,
    open_time,
    open,
    high,
    low,
    close,
    case when price = 'trade' then coalesce(base_volume, 0) end as base_volume,
    case when price = 'trade' then coalesce(quote_volume, 0) end as quote_volume,
    case when price = 'trade' then coalesce(last_trade_id, 0) end as last_trade_id,
    samples
from {{ ref('stg_lighter__candles') }}
