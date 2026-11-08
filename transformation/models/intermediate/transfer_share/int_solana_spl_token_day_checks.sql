-- The Solana checks that each day of the panel mint must pass, one row per day and check. A day is the slots
-- from_block <= slot < to_block of int_transfer_share_days, and a check whose inputs are missing does not pass.
--   source_loaded: the SPL token source read the day's first slot and reached its last. Slots can be skipped,
--     so any slot at or past the last one counts.
--   decimals_match: every token balance and movement of the mint in the day has the panel's declared decimals.
--   transactions_reconcile: in each successful transaction, each account with a balance of the mint changes
--     by its decoded movements in minus out, and each account without one nets to zero. A movement the
--     decoder missed, or one it made up, shows here.
with token as (
    select token, decimals
    from ({{ transfer_share_panel() }}) as panel
    where chain = 'solana'
),

days as (
    select day_utc, from_block, to_block
    from {{ ref('int_transfer_share_days') }}
    where chain = 'solana'
),

loaded as (
    select max(slot) as last_slot
    from {{ ref('stg_solana__spl_token_blocks') }}
),

balances as (
    select balances.*
    from {{ ref('stg_solana__spl_token_balances') }} as balances
    inner join token on token.token = coalesce(balances.pre_mint, balances.post_mint)
),

-- A movement whose mint could not be named still counts here, so it cannot hide from the reconciliation.
movements as (
    select movements.*
    from {{ ref('int_solana_spl_token_movements') }} as movements
    cross join token
    where movements.token = token.token or movements.token is null
),

wrong_decimals as (
    select slot from balances cross join token
    where coalesce(pre_decimals, post_decimals) is distinct from token.decimals
        or coalesce(post_decimals, pre_decimals) is distinct from token.decimals
    union all
    select block_number from movements cross join token
    where movements.decimals is distinct from token.decimals
),

moved as (
    select signature, account, sum(change) as change
    from (
        select tx_hash as signature, to_address as account, value_base as change
        from movements
        where to_address is not null
        union all
        select tx_hash as signature, from_address as account, -value_base as change
        from movements
        where from_address is not null
    ) as sides
    group by signature, account
),

unreconciled as (
    select transactions.slot
    from moved
    full join (
        select signature, account, coalesce(post_amount, 0) - coalesce(pre_amount, 0) as change
        from balances
    ) as balance_changes
        on balance_changes.signature = moved.signature
        and balance_changes.account = moved.account
    inner join {{ ref('stg_solana__spl_token_transactions') }} as transactions
        on transactions.signature = coalesce(moved.signature, balance_changes.signature)
    where transactions.err is null
        and coalesce(moved.change, 0) <> coalesce(balance_changes.change, 0)
),

day_failures as (
    select
        days.day_utc,
        count(*) filter (where failures.kind = 'decimals') as wrong_decimals,
        count(*) filter (where failures.kind = 'reconcile') as unreconciled
    from days
    inner join (
        select 'decimals' as kind, slot from wrong_decimals
        union all
        select 'reconcile' as kind, slot from unreconciled
    ) as failures
        on failures.slot >= days.from_block
        and failures.slot < days.to_block
    group by days.day_utc
)

select
    'solana'::text as chain,
    days.day_utc,
    checks.check_name,
    checks.passed
from days
cross join loaded
left join {{ ref('stg_solana__spl_token_blocks') }} as first_slot
    on first_slot.slot = days.from_block
left join day_failures on day_failures.day_utc = days.day_utc
cross join lateral (values
    ('source_loaded', first_slot.slot is not null and loaded.last_slot >= days.to_block - 1),
    ('decimals_match', coalesce(day_failures.wrong_decimals, 0) = 0),
    ('transactions_reconcile', coalesce(day_failures.unreconciled, 0) = 0)
) as checks (check_name, passed)
