-- One reading of one Lighter account, as the lighter-accounts source loaded it from the account endpoint.
-- read_at is when the run read it. transaction_time is Lighter's own time for the reading: the API sends
-- it in microseconds, and the epoch plus whole microseconds keeps them all, where to_timestamp of a
-- float would not. collateral leaves out unrealized pnl; total_asset_value includes it. positions and
-- assets stay jsonb for the intermediate models to explode, and shares and pending_unlocks stay jsonb
-- for later. Field meanings are in catalog/vendors/lighter/NOTES.md, Snapshots.
select
    id,
    (data -> 'account' ->> 'index')::bigint as account_index,
    to_timestamp((data ->> 'read_at')::bigint / 1000.0) as read_at,
    lower(data -> 'account' ->> 'l1_address') as l1_address,
    (data -> 'account' ->> 'account_type')::integer as account_type,
    (data -> 'account' ->> 'status')::integer as status,
    (data -> 'account' ->> 'collateral')::numeric as collateral,
    (data -> 'account' ->> 'available_balance')::numeric as available_balance,
    (data -> 'account' ->> 'total_asset_value')::numeric as total_asset_value,
    (data -> 'account' ->> 'cross_asset_value')::numeric as cross_asset_value,
    (data -> 'account' ->> 'cross_initial_margin_requirement')::numeric as cross_initial_margin_requirement,
    (data -> 'account' ->> 'cross_maintenance_margin_requirement')::numeric as cross_maintenance_margin_requirement,
    timestamptz 'epoch' + (data -> 'account' ->> 'transaction_time')::bigint * interval '1 microsecond' as transaction_time,
    data -> 'account' -> 'positions' as positions,
    data -> 'account' -> 'assets' as assets,
    data -> 'account' -> 'shares' as shares,
    data -> 'account' -> 'pending_unlocks' as pending_unlocks,
    _loaded_at
from {{ source('lighter', 'accounts') }}
