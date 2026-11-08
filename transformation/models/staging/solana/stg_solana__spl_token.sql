-- One SPL Token program instruction, outer or inner, that touches a tracked mint, a token account with a
-- tracked-mint balance in its transaction, or an account an initializeAccount* of the mint made in that
-- transaction. instruction is the name Pipes' tokenProgram ABI decoded, or null
-- when it could not. accounts are positional, in the order the ABI lists them. instruction_address is the
-- path Portal gives, outer index first, so comparing two of them orders a transaction's instructions.
-- Addresses are base58 and kept byte for byte. amount is in base units and null when its text is not all digits.
select
    id,
    (data ->> 'slot')::bigint as slot,
    (data ->> 'tx_index')::integer as tx_index,
    data ->> 'signature' as signature,
    array(
        select address::integer
        from jsonb_array_elements_text(data -> 'instruction_address') with ordinality as path (address, depth)
        order by depth
    ) as instruction_address,
    data ->> 'program_id' as program_id,
    data -> 'accounts' as accounts,
    (data ->> 'is_committed')::boolean as is_committed,
    data ->> 'instruction' as instruction,
    {{ unsigned_numeric("data -> 'args' ->> 'amount'") }} as amount,
    (data -> 'args' ->> 'decimals')::integer as decimals,
    -- initializeAccount2, initializeAccount3
    data -> 'args' ->> 'owner' as owner_arg,
    -- setAuthority
    data -> 'args' -> 'authorityType' ->> 'kind' as authority_type,
    data -> 'args' ->> 'newAuthority' as new_authority,
    _loaded_at
from {{ source('solana', 'spl_token') }}
where data ->> 'kind' = 'instruction'
