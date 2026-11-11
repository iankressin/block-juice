-- One state read of one wallet in chains/ethereum/addresses.json of evm-account-state, at one block, as the
-- RPC returned it. kind says which: 'balance' (eth_getBalance, in wei), 'nonce' (eth_getTransactionCount)
-- or 'code' (eth_getCode, '0x' when the address has none). The other two value columns are null.
select
    id,
    data ->> 'kind' as kind,
    (data ->> 'block_number')::bigint as block_number,
    lower(data ->> 'address') as address,
    (data ->> 'balance')::numeric as balance,
    (data ->> 'nonce')::bigint as nonce,
    lower(data ->> 'code') as code,
    _loaded_at
from {{ source('ethereum', 'account_state') }}
