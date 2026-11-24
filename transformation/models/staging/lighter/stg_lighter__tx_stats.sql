-- One closed hour of Lighter's tx counts, as the lighter-tx-stats source loaded it. The source keeps the
-- reply's types list, ["timestamp","count","uopsCount"], and refuses a changed one, so each point is read by
-- position: [0] is the hour's start in seconds, [1] its tx count and [2] its user-op count.
select
    id,
    to_timestamp((data -> 'point' ->> 0)::bigint) as hour,
    (data -> 'point' ->> 1)::bigint as tx_count,
    (data -> 'point' ->> 2)::bigint as uops_count,
    _loaded_at
from {{ source('lighter', 'tx_stats') }}
