-- One reading of one Lighter account, one row per run that read it. collateral leaves out unrealized
-- pnl; total_asset_value includes it. transaction_time is Lighter's time for the reading, read_at ours.
select
    id,
    account_index,
    read_at,
    l1_address,
    account_type,
    status,
    collateral,
    available_balance,
    total_asset_value,
    cross_asset_value,
    cross_initial_margin_requirement,
    cross_maintenance_margin_requirement,
    transaction_time
from {{ ref('stg_lighter__accounts') }}
