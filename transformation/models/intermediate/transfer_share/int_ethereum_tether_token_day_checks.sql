-- The Ethereum checks that each day of the panel token must pass, one row per day and check. A day is the
-- blocks from_block <= block < to_block of int_transfer_share_days, and a check whose inputs are missing
-- does not pass.
--   source_loaded: the token source read the day's first block and reached its last.
--   transactions_recorded: every log of the token in the day has its transaction record.
--   supply_events_paired: every Issue and Redeem in the day became exactly one movement. A tie between
--     candidate Transfers leaves a movement with no family.
--   decimals_match: decimals() at both supply checkpoints is the panel's declared decimals.
--   supply_reconciles: totalSupply() at the day's last block minus totalSupply() at the block before the
--     day equals the day's issuance minus its destruction, in base units.
--   token_contract_unchanged: no Params with a non-zero fee and no Deprecate at or before the day's last
--     block, since the movement rules assume neither.
with token as (
    select token, decimals
    from ({{ transfer_share_panel() }}) as panel
    where chain = 'ethereum'
),

days as (
    select day_utc, from_block, to_block
    from {{ ref('int_transfer_share_days') }}
    where chain = 'ethereum'
),

loaded as (
    select max(block_number) as last_block
    from {{ ref('stg_ethereum__tether_token_blocks') }}
),

supply as (
    select supply.block_number, supply.total_supply, supply.decimals
    from {{ ref('stg_ethereum__erc20_supply') }} as supply
    inner join token on token.token = supply.token
),

day_movements as (
    select
        days.day_utc,
        sum(
            case movements.family
                when 'issuance' then movements.value_base
                when 'destruction' then -movements.value_base
            end
        ) filter (where movements.changes_supply) as net_issuance,
        count(*) filter (where movements.family is null) as unpaired
    from days
    inner join {{ ref('int_ethereum_tether_token_movements') }} as movements
        on movements.block_number >= days.from_block
        and movements.block_number < days.to_block
    inner join token on token.token = movements.token
    group by days.day_utc
),

logs as (
    select logs.block_number, logs.event, logs.fee_basis_points, logs.max_fee, transactions.hash as transaction
    from {{ ref('stg_ethereum__tether_token') }} as logs
    inner join token on token.token = logs.contract
    left join {{ ref('stg_ethereum__tether_token_transactions') }} as transactions
        on transactions.hash = logs.tx_hash
),

missing_transactions as (
    select days.day_utc, count(*) as logs
    from days
    inner join logs
        on logs.block_number >= days.from_block
        and logs.block_number < days.to_block
    where logs.transaction is null
    group by days.day_utc
),

contract_changes as (
    select min(block_number) as first_block
    from logs
    where event = 'Deprecate'
        or (event = 'Params' and fee_basis_points > 0 and max_fee > 0)
)

select
    'ethereum'::text as chain,
    days.day_utc,
    checks.check_name,
    checks.passed
from days
cross join token
cross join loaded
cross join contract_changes
left join {{ ref('stg_ethereum__tether_token_blocks') }} as first_block
    on first_block.block_number = days.from_block
left join supply as opening on opening.block_number = days.from_block - 1
left join supply as closing on closing.block_number = days.to_block - 1
left join day_movements on day_movements.day_utc = days.day_utc
left join missing_transactions on missing_transactions.day_utc = days.day_utc
cross join lateral (values
    ('source_loaded', first_block.block_number is not null and loaded.last_block >= days.to_block - 1),
    ('transactions_recorded', missing_transactions.day_utc is null),
    ('supply_events_paired', coalesce(day_movements.unpaired, 0) = 0),
    ('decimals_match', opening.decimals = token.decimals and closing.decimals = token.decimals),
    ('supply_reconciles', closing.total_supply - opening.total_supply = coalesce(day_movements.net_issuance, 0)),
    ('token_contract_unchanged', contract_changes.first_block is null or contract_changes.first_block >= days.to_block)
) as checks (check_name, passed)
