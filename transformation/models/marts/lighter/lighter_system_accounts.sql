-- The five system accounts of Lighter, one row per role, from the latest systemConfig reading.
with latest as (
    select *
    from {{ ref('stg_lighter__system_config') }}
    order by read_at desc
    limit 1
)

select
    roles.role,
    roles.account_index,
    latest.read_at
from latest
cross join lateral (
    values
        ('liquidity_pool', latest.liquidity_pool_index),
        ('staking_pool', latest.staking_pool_index),
        ('funding_fee_rebate', latest.funding_fee_rebate_account_index),
        ('market_maker_incentive', latest.market_maker_incentive_account_index),
        ('fee_collector', latest.fee_collector_account_index)
) as roles (role, account_index)
