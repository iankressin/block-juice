-- One Transfer log of a token in the source's addresses.json, into or out of one of its wallets.
-- value is in the token's base units.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'log_index')::integer as log_index,
    data ->> 'token' as token,
    data ->> 'from' as from_address,
    data ->> 'to' as to_address,
    (data ->> 'value')::numeric as value,
    _loaded_at
from {{ source('ethereum', 'erc20_transfers') }}
