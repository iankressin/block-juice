-- One transaction that a log of the Tether token source came from, as Portal returned it. The logs are in
-- stg_ethereum__tether_token, and their tx_hash is this hash.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'tx_index')::integer as tx_index,
    data ->> 'hash' as hash,
    lower(data ->> 'from') as from_address,
    lower(data ->> 'to') as to_address,
    _loaded_at
from {{ source('ethereum', 'tether_token') }}
where data ->> 'kind' = 'transaction'
