-- One block header a day-boundary call read, from Portal or over RPC: the first block at or after a UTC
-- midnight, or the block before it. int_ethereum_day_boundaries proves each midnight from these.
select
    id,
    data ->> 'origin' as origin,
    (data ->> 'number')::bigint as block_number,
    data ->> 'hash' as block_hash,
    data ->> 'parent_hash' as parent_hash,
    (data ->> 'parent_number')::bigint as parent_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    _loaded_at
from {{ source('ethereum', 'block_headers') }}
where data ->> 'kind' = 'header'
