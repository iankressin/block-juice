-- One slot the SPL token source read, written for every produced slot in its range whether or not it holds
-- a tracked balance, so the slots show how far the source loaded. block_timestamp is null when Portal has none.
select
    id,
    (data ->> 'slot')::bigint as slot,
    data ->> 'block_hash' as block_hash,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    _loaded_at
from {{ source('solana', 'spl_token') }}
where data ->> 'kind' = 'block'
