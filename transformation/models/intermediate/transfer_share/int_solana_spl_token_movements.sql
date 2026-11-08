-- SPL token movements on Solana in the shape token_movements reads: each transfer, transferChecked, mintTo,
-- mintToChecked, burn and burnChecked instruction, outer or inner, of a successful transaction. from_address
-- and to_address are token accounts, and from_owner and to_owner the owners in effect at the instruction.
-- value_base is in base units, and decimals is what the chain reports for the mint.
-- Rules (decision 7, rule_version 1, and the README's Solana owner intervals):
--   mintTo adds supply and burn removes it. A transfer never changes supply.
--   The mint is the instruction's mint account when it names one. An unchecked transfer takes it from the
--   source account's token balance, else the destination's, else from an initializeAccount* of either account
--   earlier in the transaction, since Portal gives no balance to an account made and closed in one transaction.
--   An account's owner starts at Portal's pre_owner, or none when it has no balance. setAuthority (account
--   owner), initializeAccount* and closeAccount on the account change it for the later instructions of the
--   transaction, in instruction_address order. A side is unresolved when the walk names no owner, or when the
--   owner the walk ends on is not Portal's post_owner, and an unresolved owner is null.
with instructions as (
    select instructions.*
    from {{ ref('stg_solana__spl_token') }} as instructions
    inner join {{ ref('stg_solana__spl_token_transactions') }} as transactions
        on transactions.signature = instructions.signature
    where transactions.err is null
        and instructions.program_id = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
),

-- Which positional account of each movement instruction is the source, the destination and the mint, from
-- Pipes' tokenProgram ABI.
rules (instruction, family, changes_supply, from_account, to_account, mint_account) as (
    values
        ('transfer', 'transfer', false, 0, 1, null::integer),
        ('transferChecked', 'transfer', false, 0, 2, 1),
        ('mintTo', 'issuance', true, null, 1, 0),
        ('mintToChecked', 'issuance', true, null, 1, 0),
        ('burn', 'destruction', true, 0, null, 1),
        ('burnChecked', 'destruction', true, 0, null, 1)
),

movements as (
    select
        instructions.id,
        instructions.slot,
        instructions.tx_index,
        instructions.signature,
        instructions.instruction_address,
        instructions.instruction,
        rules.family,
        rules.changes_supply,
        instructions.accounts ->> rules.from_account as from_address,
        instructions.accounts ->> rules.to_account as to_address,
        instructions.accounts ->> rules.mint_account as named_mint,
        instructions.decimals as named_decimals,
        instructions.amount as value_base
    from instructions
    inner join rules on rules.instruction = instructions.instruction
),

-- Each instruction that sets or ends a token account's owner, with the owner it leaves (none after
-- closeAccount) and, for initializeAccount*, the account's mint.
owner_changes as (
    select
        signature,
        instruction_address,
        accounts ->> 0 as account,
        case instruction
            when 'initializeAccount' then accounts ->> 2
            when 'initializeAccount2' then owner_arg
            when 'initializeAccount3' then owner_arg
            when 'setAuthority' then new_authority
        end as owner,
        case when instruction like 'initializeAccount%' then accounts ->> 1 end as mint
    from instructions
    where instruction in ('initializeAccount', 'initializeAccount2', 'initializeAccount3', 'closeAccount')
        or (instruction = 'setAuthority' and authority_type = 'AccountOwner')
),

-- Each side of a movement on its own row, so both sides take the same owner walk.
sides as (
    select id, 'from' as side, signature, instruction_address, from_address as account
    from movements
    where from_address is not null
    union all
    select id, 'to' as side, signature, instruction_address, to_address as account
    from movements
    where to_address is not null
),

last_change_before as (
    select distinct on (sides.id, sides.side)
        sides.id,
        sides.side,
        owner_changes.owner
    from sides
    inner join owner_changes
        on owner_changes.signature = sides.signature
        and owner_changes.account = sides.account
        and owner_changes.instruction_address < sides.instruction_address
    order by sides.id, sides.side, owner_changes.instruction_address desc
),

last_init_before as (
    select distinct on (sides.id, sides.side)
        sides.id,
        sides.side,
        owner_changes.mint
    from sides
    inner join owner_changes
        on owner_changes.signature = sides.signature
        and owner_changes.account = sides.account
        and owner_changes.instruction_address < sides.instruction_address
    where owner_changes.mint is not null
    order by sides.id, sides.side, owner_changes.instruction_address desc
),

last_change as (
    select distinct on (signature, account)
        signature,
        account,
        owner
    from owner_changes
    order by signature, account, instruction_address desc
),

walked as (
    select
        sides.id,
        sides.side,
        case
            when last_change_before.id is not null then last_change_before.owner
            else balances.pre_owner
        end as owner,
        -- With no balance there is no post_owner to hold the walk to.
        balances.account is null
            or case
                when last_change.account is not null then last_change.owner
                else balances.pre_owner
            end is not distinct from balances.post_owner as ends_on_post_owner,
        coalesce(balances.pre_mint, balances.post_mint) as balance_mint,
        last_init_before.mint as init_mint,
        coalesce(balances.pre_decimals, balances.post_decimals) as decimals
    from sides
    left join last_change_before
        on last_change_before.id = sides.id
        and last_change_before.side = sides.side
    left join last_init_before
        on last_init_before.id = sides.id
        and last_init_before.side = sides.side
    left join {{ ref('stg_solana__spl_token_balances') }} as balances
        on balances.signature = sides.signature
        and balances.account = sides.account
    left join last_change
        on last_change.signature = sides.signature
        and last_change.account = sides.account
),

resolved as (
    select
        id,
        side,
        case when owner is not null and ends_on_post_owner then owner end as owner,
        owner is not null and ends_on_post_owner as is_resolved,
        balance_mint,
        init_mint,
        decimals
    from walked
),

placed as (
    select
        movements.*,
        coalesce(
            movements.named_mint,
            from_side.balance_mint,
            to_side.balance_mint,
            from_side.init_mint,
            to_side.init_mint
        ) as token,
        from_side.owner as from_owner,
        to_side.owner as to_owner,
        coalesce(from_side.is_resolved, true) and coalesce(to_side.is_resolved, true) as is_resolved,
        coalesce(from_side.decimals, to_side.decimals, movements.named_decimals) as decimals
    from movements
    left join resolved as from_side
        on from_side.id = movements.id
        and from_side.side = 'from'
    left join resolved as to_side
        on to_side.id = movements.id
        and to_side.side = 'to'
)

select
    placed.id,
    'solana'::text as chain,
    placed.token,
    placed.slot as block_number,
    blocks.block_hash,
    blocks.block_timestamp,
    placed.signature as tx_hash,
    placed.tx_index,
    placed.tx_index || ':' || array_to_string(placed.instruction_address, '.') as position,
    placed.instruction as event,
    placed.family,
    placed.changes_supply,
    placed.from_address,
    placed.to_address,
    placed.from_owner,
    placed.to_owner,
    case when placed.is_resolved then 'resolved' else 'unresolved' end as owner_status,
    placed.value_base,
    placed.decimals,
    trim_scale(placed.value_base * power(10::numeric, -placed.decimals)) as value_tokens,
    coalesce(placed.from_address = placed.to_address, false) as account_self,
    coalesce(placed.is_resolved and placed.from_owner = placed.to_owner, false) as owner_self
from placed
left join {{ ref('stg_solana__spl_token_blocks') }} as blocks
    on blocks.slot = placed.slot
