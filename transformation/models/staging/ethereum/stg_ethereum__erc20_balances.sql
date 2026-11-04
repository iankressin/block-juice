-- balance is null when the call reverted, e.g. the token was not deployed yet at that block.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    data ->> 'wallet' as wallet,
    data ->> 'token' as token,
    (data ->> 'balance')::numeric as balance,
    _loaded_at
from {{ source('ethereum', 'erc20_balances') }}
