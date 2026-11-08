-- The TRON checks that each day of the panel token must pass, one row per day and check. A day is the
-- blocks from_block <= block < to_block of int_transfer_share_days, and a check whose inputs are missing
-- does not pass. Nothing on TRON reads decimals() or totalSupply(), so neither is checked here.
--   source_loaded: the token source read the day's first block and reached its last.
--   results_success: every log of the token in the day has a transaction whose result is SUCCESS. TRON
--     keeps no log of a reverted transaction, so any other result, or none, means the field is not what the
--     movements filter on, and those movements would drop without a trace.
--   supply_events_paired: every Issue and Redeem in the day became exactly one movement. A tie between
--     candidate Transfers leaves a movement with no family.
--   zero_transfers_proved: no Transfer to or from the zero address in the day pairs with nothing, since
--     whether such a Transfer changes supply on TRON is not proved.
--   token_contract_unchanged: no Params with a non-zero fee and no Deprecate at or before the day's last
--     block, since the movement rules assume neither.
with token as (
    select token
    from ({{ transfer_share_panel() }}) as panel
    where chain = 'tron'
),

days as (
    select day_utc, from_block, to_block
    from {{ ref('int_transfer_share_days') }}
    where chain = 'tron'
),

loaded as (
    select max(block_number) as last_block
    from {{ ref('stg_tron__tether_token_blocks') }}
),

logs as (
    select logs.block_number, logs.event, logs.fee_basis_points, logs.max_fee, transactions.result
    from {{ ref('stg_tron__tether_token') }} as logs
    inner join token on token.token = logs.contract
    left join {{ ref('stg_tron__tether_token_transactions') }} as transactions
        on transactions.hash = logs.tx_hash
),

unsuccessful as (
    select days.day_utc, count(*) as logs
    from days
    inner join logs
        on logs.block_number >= days.from_block
        and logs.block_number < days.to_block
    where logs.result is distinct from 'SUCCESS'
    group by days.day_utc
),

day_movements as (
    select
        days.day_utc,
        count(*) filter (where movements.family is null) as unpaired,
        count(*) filter (where movements.family is not null and movements.changes_supply is null) as unproved
    from days
    inner join {{ ref('int_tron_tether_token_movements') }} as movements
        on movements.block_number >= days.from_block
        and movements.block_number < days.to_block
    inner join token on token.token = movements.token
    group by days.day_utc
),

contract_changes as (
    select min(block_number) as first_block
    from logs
    where event = 'Deprecate'
        or (event = 'Params' and fee_basis_points > 0 and max_fee > 0)
)

select
    'tron'::text as chain,
    days.day_utc,
    checks.check_name,
    checks.passed
from days
cross join token
cross join loaded
cross join contract_changes
left join {{ ref('stg_tron__tether_token_blocks') }} as first_block
    on first_block.block_number = days.from_block
left join unsuccessful on unsuccessful.day_utc = days.day_utc
left join day_movements on day_movements.day_utc = days.day_utc
cross join lateral (values
    ('source_loaded', first_block.block_number is not null and loaded.last_block >= days.to_block - 1),
    ('results_success', unsuccessful.day_utc is null),
    ('supply_events_paired', coalesce(day_movements.unpaired, 0) = 0),
    ('zero_transfers_proved', coalesce(day_movements.unproved, 0) = 0),
    ('token_contract_unchanged', contract_changes.first_block is null or contract_changes.first_block >= days.to_block)
) as checks (check_name, passed)
