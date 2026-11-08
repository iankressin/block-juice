-- One token's totalSupply() and decimals() at the last block before a UTC midnight. total_supply is in base
-- units and is null when its text is not all digits; decimals is null when decimals() returned nothing.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'midnight')::timestamptz as midnight,
    lower(data ->> 'token') as token,
    {{ unsigned_numeric("data ->> 'total_supply'") }} as total_supply,
    (data ->> 'decimals')::integer as decimals,
    _loaded_at
from {{ source('ethereum', 'erc20_supply') }}
