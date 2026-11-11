-- One state diff of a transaction that has at least one create or create2 trace, as Portal returned it:
-- one account field (key 'balance', 'nonce' or 'code') or one storage slot (key a 32-byte hex slot) of
-- one address. diff_kind is '+' for a field of an account the transaction created, with no prev, '*' for
-- a changed field, with prev and next, and '-' for a field of an account the transaction deleted, with no
-- next. Portal sends no '=' rows. A storage slot's '*' can go from zero, so new slots are decided by prev
-- and next, not by the kind.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'transaction_index')::integer as transaction_index,
    lower(data ->> 'address') as address,
    lower(data ->> 'key') as key,
    data ->> 'key' like '0x%' as is_storage,
    data ->> 'diff_kind' as diff_kind,
    lower(data ->> 'prev') as prev,
    lower(data ->> 'next') as next,
    _loaded_at
from {{ source('ethereum', 'contract_deployments') }}
where data ->> 'kind' = 'state_diff'
