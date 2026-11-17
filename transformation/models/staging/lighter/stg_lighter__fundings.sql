-- One hourly funding entry of one Lighter perp market, as the lighter-fundings source loaded it.
-- funding_time is the hour mark the entry is paid at, from timestamp in seconds. rate_pct is the
-- percent per hour and is unsigned: direction carries the sign. value_usdc_per_unit is USDC per one
-- unit of base. Meanings are in catalog/vendors/lighter/NOTES.md.
select
    id,
    (data ->> 'market_id')::integer as market_id,
    data ->> 'symbol' as symbol,
    to_timestamp((data -> 'funding' ->> 'timestamp')::bigint) as funding_time,
    (data -> 'funding' ->> 'rate')::numeric as rate_pct,
    (data -> 'funding' ->> 'value')::numeric as value_usdc_per_unit,
    data -> 'funding' ->> 'direction' as direction,
    _loaded_at
from {{ source('lighter', 'fundings') }}
