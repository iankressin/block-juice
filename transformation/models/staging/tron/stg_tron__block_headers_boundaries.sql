-- One UTC midnight a TRON day-boundary call resolved: boundary_block is Portal's first block at or after it.
select
    id,
    (data ->> 'midnight')::timestamptz as midnight,
    (data ->> 'block')::bigint as boundary_block,
    _loaded_at
from {{ source('tron', 'block_headers') }}
where data ->> 'kind' = 'boundary'
