-- One point of a listed account's value series, one row per account, resolution and point time. Every column
-- but volume is a running total since the account began, up to point_time, and the point at midnight D holds
-- the totals up to D. perps_value is inflow - outflow + trade_pnl, which equals the account's collateral plus
-- unrealized pnl at that time (catalog/vendors/lighter/NOTES.md, Account value, L14).
select
    id,
    account_index,
    resolution,
    point_time,
    inflow - outflow + trade_pnl as perps_value,
    trade_pnl,
    trade_spot_pnl,
    inflow,
    outflow,
    spot_inflow,
    spot_outflow,
    pool_pnl,
    pool_inflow,
    pool_outflow,
    staking_pnl,
    staking_inflow,
    staking_outflow,
    pool_total_shares,
    volume
from {{ ref('stg_lighter__pnl') }}
