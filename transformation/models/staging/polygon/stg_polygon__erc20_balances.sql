-- One balanceOf reading of a token for a wallet in chains/polygon/addresses.json of evm-erc20-balances.
-- balance is in the token's base units, null when the call reverted, e.g. the token was not deployed yet
-- at that block. Wallet and token addresses are lowercased.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    lower(data ->> 'wallet') as wallet,
    lower(data ->> 'token') as token,
    (data ->> 'balance')::numeric as balance,
    _loaded_at
from {{ source('polygon', 'erc20_balances') }}
