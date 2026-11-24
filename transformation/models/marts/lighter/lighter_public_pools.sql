-- One reading of one Lighter public pool. Each run adds a reading per pool, so a pool's value and
-- yield can be followed over time. The LLP is account_index 281474976710654 (account_type 3).
select
    id,
    account_index,
    read_at,
    name,
    account_type,
    master_account_index,
    operator_fee,
    annual_percentage_yield,
    total_asset_value,
    total_spot_value,
    total_perps_value,
    total_shares,
    status,
    created_at
from {{ ref('stg_lighter__public_pools') }}
