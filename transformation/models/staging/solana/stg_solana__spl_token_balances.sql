-- One token account's balance of a tracked mint before and after one transaction, as Portal returned it.
-- An account the transaction created has no pre_* values, and one it closed has no post_* values. Addresses
-- are base58 and kept byte for byte. Amounts are in base units and null when their text is not all digits.
select
    id,
    (data ->> 'slot')::bigint as slot,
    (data ->> 'tx_index')::integer as tx_index,
    data ->> 'signature' as signature,
    data ->> 'account' as account,
    data ->> 'pre_mint' as pre_mint,
    data ->> 'post_mint' as post_mint,
    data ->> 'pre_owner' as pre_owner,
    data ->> 'post_owner' as post_owner,
    {{ unsigned_numeric("data ->> 'pre_amount'") }} as pre_amount,
    {{ unsigned_numeric("data ->> 'post_amount'") }} as post_amount,
    (data ->> 'pre_decimals')::integer as pre_decimals,
    (data ->> 'post_decimals')::integer as post_decimals,
    data ->> 'pre_program_id' as pre_program_id,
    data ->> 'post_program_id' as post_program_id,
    _loaded_at
from {{ source('solana', 'spl_token') }}
where data ->> 'kind' = 'token_balance'
