-- One Tether token log as the source loaded it, for a contract in its addresses.json. Each event fills the
-- columns of its own arguments and leaves the others null. Amounts are in the token's base units, and an
-- amount whose text is not all digits is null.
select
    id,
    data ->> 'event' as event,
    (data ->> 'block_number')::bigint as block_number,
    data ->> 'block_hash' as block_hash,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    data ->> 'tx_hash' as tx_hash,
    (data ->> 'tx_index')::integer as tx_index,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'contract') as contract,
    -- Transfer
    lower(data -> 'args' ->> 'from') as from_address,
    lower(data -> 'args' ->> 'to') as to_address,
    {{ unsigned_numeric("data -> 'args' ->> 'value'") }} as value,
    -- Issue, Redeem
    {{ unsigned_numeric("data -> 'args' ->> 'amount'") }} as amount,
    -- DestroyedBlackFunds
    lower(data -> 'args' ->> '_blackListedUser') as blacklisted_user,
    {{ unsigned_numeric("data -> 'args' ->> '_balance'") }} as blacklisted_balance,
    -- AddedBlackList, RemovedBlackList
    lower(data -> 'args' ->> '_user') as listed_user,
    -- Params
    {{ unsigned_numeric("data -> 'args' ->> 'feeBasisPoints'") }} as fee_basis_points,
    {{ unsigned_numeric("data -> 'args' ->> 'maxFee'") }} as max_fee,
    -- Deprecate
    lower(data -> 'args' ->> 'newAddress') as new_address,
    _loaded_at
from {{ source('ethereum', 'tether_token') }}
where data ->> 'kind' = 'log'
