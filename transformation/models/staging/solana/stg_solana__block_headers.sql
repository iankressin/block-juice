-- One Solana block header a day-boundary call read, from Portal or over RPC (getBlock): the first produced
-- slot at or after a UTC midnight, or the produced slot before it. block_number is the slot, and
-- parent_number the parentSlot. An RPC blockTime of null stays null. int_solana_day_boundaries proves each
-- midnight from these.
select
    id,
    data ->> 'origin' as origin,
    (data ->> 'number')::bigint as block_number,
    data ->> 'hash' as block_hash,
    data ->> 'parent_hash' as parent_hash,
    (data ->> 'parent_number')::bigint as parent_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    _loaded_at
from {{ source('solana', 'block_headers') }}
where data ->> 'kind' = 'header'
