-- One reading of Lighter's systemConfig, as the lighter-system-config source loaded it. Only the five
-- system accounts are read; the reply's limits and periods stay in the raw row.
select
    id,
    to_timestamp((data ->> 'read_at')::bigint / 1000.0) as read_at,
    (data -> 'config' ->> 'liquidity_pool_index')::bigint as liquidity_pool_index,
    (data -> 'config' ->> 'staking_pool_index')::bigint as staking_pool_index,
    (data -> 'config' ->> 'funding_fee_rebate_account_index')::bigint as funding_fee_rebate_account_index,
    (data -> 'config' ->> 'market_maker_incentive_account_index')::bigint as market_maker_incentive_account_index,
    (data -> 'config' ->> 'fee_collector_account_index')::bigint as fee_collector_account_index,
    _loaded_at
from {{ source('lighter', 'system_config') }}
