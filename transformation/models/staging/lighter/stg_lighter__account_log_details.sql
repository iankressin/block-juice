-- One logs/{hash} reply, as the lighter-account-logs source loaded it: the L2 block that holds the entry
-- and the Explorer's batch for it. A fresh entry has its block at once and its batch_number and status
-- null until its batch forms. The source reads a detail again while its entry is within a walk, so an
-- older detail can keep a null batch_number: join the batch on block_number.
select
    id,
    data ->> 'hash' as hash,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'batch_number')::bigint as batch_number,
    data ->> 'status' as status,
    _loaded_at
from {{ source('lighter', 'account_logs') }}
where id like 'detail:%'
