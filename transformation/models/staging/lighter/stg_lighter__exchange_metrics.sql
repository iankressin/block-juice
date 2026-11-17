-- One daily point of one Lighter exchange metric, as the lighter-exchange-metrics source loaded it.
-- day is the UTC day the point covers, from timestamp in seconds. market is the symbol for a market
-- series and null for an exchange-wide one. value is the number Lighter sent, in the kind's own unit.
-- Meanings are in catalog/vendors/lighter/NOTES.md.
select
    id,
    ((to_timestamp((data -> 'point' ->> 'timestamp')::bigint) at time zone 'UTC'))::date as day,
    data ->> 'kind' as kind,
    data ->> 'market' as market,
    (data -> 'point' ->> 'data')::numeric as value,
    _loaded_at
from {{ source('lighter', 'exchange_metrics') }}
