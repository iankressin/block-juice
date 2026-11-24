-- One Lighter candle, trade or mark price, as the lighter-candles source loaded it. open_time is the
-- bucket start, from t in milliseconds. Prices are USDC per base unit. v, V and i are cast as loaded:
-- Lighter leaves a zero field out, so they can be null, and lighter_candles reads a missing one on a
-- trade candle as 0. samples counts the mark-price samples in the bucket. Meanings are in
-- catalog/vendors/lighter/NOTES.md.
select
    id,
    (data ->> 'market_id')::integer as market_id,
    data ->> 'symbol' as symbol,
    data ->> 'price' as price,
    data ->> 'resolution' as resolution,
    to_timestamp((data -> 'candle' ->> 't')::bigint / 1000.0) as open_time,
    (data -> 'candle' ->> 'o')::numeric as open,
    (data -> 'candle' ->> 'h')::numeric as high,
    (data -> 'candle' ->> 'l')::numeric as low,
    (data -> 'candle' ->> 'c')::numeric as close,
    (data -> 'candle' ->> 'v')::numeric as base_volume,
    (data -> 'candle' ->> 'V')::numeric as quote_volume,
    (data -> 'candle' ->> 'i')::bigint as last_trade_id,
    (data -> 'candle' ->> 'sc')::bigint as samples,
    _loaded_at
from {{ source('lighter', 'candles') }}
