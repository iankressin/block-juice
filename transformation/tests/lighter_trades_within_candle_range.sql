-- Fails for each trade whose price lies outside the low-high range of its market's 1h trade candle,
-- by more than a relative 1e-9 (candle prices come from JSON doubles). It catches wrong decimals and
-- wrong market ids. A trade with no candle, or a null price (a binary option), is skipped.
select
    trades.trade_id,
    trades.market_id,
    trades.price,
    candles.open_time,
    candles.low,
    candles.high
from {{ ref('lighter_trades') }} as trades
inner join {{ ref('lighter_candles') }} as candles
    on candles.market_id = trades.market_id
    and candles.price = 'trade'
    and candles.resolution = '1h'
    and candles.open_time = date_trunc('hour', trades.trade_time, 'UTC')
where trades.price < candles.low * (1 - 1e-9)
    or trades.price > candles.high * (1 + 1e-9)
