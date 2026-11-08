-- One TRON block the Tether token source read, written for every block in its range whether or not it holds
-- a log, so the blocks show how far the source loaded.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    data ->> 'block_hash' as block_hash,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    _loaded_at
from {{ source('tron', 'tether_token') }}
where data ->> 'kind' = 'block'
