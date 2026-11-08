-- One UTC midnight a Solana day-boundary call resolved: boundary_block is Portal's first produced slot at or
-- after it.
select
    id,
    (data ->> 'midnight')::timestamptz as midnight,
    (data ->> 'block')::bigint as boundary_block,
    _loaded_at
from {{ source('solana', 'block_headers') }}
where data ->> 'kind' = 'boundary'
