-- One Lighter candle, trade or mark price, as the lighter-candles source loaded it. open_time is the
-- bucket start, from t in milliseconds. Prices are USDC per base unit. For a trade candle Lighter
-- leaves a zero field out, so a missing v, V or i is 0. A mark candle has no volume or trade id, and
-- those stay null. samples counts the mark-price samples in the bucket. Meanings are in
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
    case when data ->> 'price' = 'trade' then coalesce((data -> 'candle' ->> 'v')::numeric, 0) end as base_volume,
    case when data ->> 'price' = 'trade' then coalesce((data -> 'candle' ->> 'V')::numeric, 0) end as quote_volume,
    case when data ->> 'price' = 'trade' then coalesce((data -> 'candle' ->> 'i')::bigint, 0) end as last_trade_id,
    (data -> 'candle' ->> 'sc')::bigint as samples,
    _loaded_at
from {{ source('lighter', 'candles') }}
