-- One transaction that holds a tracked-mint token balance, as Portal returned it. err is null when the
-- transaction succeeded.
select
    id,
    (data ->> 'slot')::bigint as slot,
    (data ->> 'tx_index')::integer as tx_index,
    data ->> 'signature' as signature,
    nullif(data -> 'err', 'null'::jsonb) as err,
    _loaded_at
from {{ source('solana', 'spl_token') }}
where data ->> 'kind' = 'transaction'
