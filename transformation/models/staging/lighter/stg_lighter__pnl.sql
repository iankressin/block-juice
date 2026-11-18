-- One point of an account's value series, as the lighter-pnl source loaded it from the pnl endpoint. Lighter
-- sends the values as JSON numbers, so they keep up to 15 significant digits. Every column but volume is a
-- running total since the account began, up to point_time. The source keeps only points on the resolution's
-- boundary: UTC midnight for 1d and the hour mark for 1h. Field meanings are in
-- catalog/vendors/lighter/NOTES.md, Account value.
select
    id,
    (data ->> 'account_index')::bigint as account_index,
    data ->> 'resolution' as resolution,
    to_timestamp((data -> 'point' ->> 'timestamp')::bigint) as point_time,
    (data -> 'point' ->> 'trade_pnl')::numeric as trade_pnl,
    (data -> 'point' ->> 'trade_spot_pnl')::numeric as trade_spot_pnl,
    (data -> 'point' ->> 'inflow')::numeric as inflow,
    (data -> 'point' ->> 'outflow')::numeric as outflow,
    (data -> 'point' ->> 'spot_inflow')::numeric as spot_inflow,
    (data -> 'point' ->> 'spot_outflow')::numeric as spot_outflow,
    (data -> 'point' ->> 'pool_pnl')::numeric as pool_pnl,
    (data -> 'point' ->> 'pool_inflow')::numeric as pool_inflow,
    (data -> 'point' ->> 'pool_outflow')::numeric as pool_outflow,
    (data -> 'point' ->> 'staking_pnl')::numeric as staking_pnl,
    (data -> 'point' ->> 'staking_inflow')::numeric as staking_inflow,
    (data -> 'point' ->> 'staking_outflow')::numeric as staking_outflow,
    (data -> 'point' ->> 'pool_total_shares')::numeric as pool_total_shares,
    (data -> 'point' ->> 'volume')::numeric as volume,
    _loaded_at
from {{ source('lighter', 'pnl') }}
