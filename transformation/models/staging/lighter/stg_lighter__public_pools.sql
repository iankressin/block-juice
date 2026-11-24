-- One reading of one Lighter public pool, as the lighter-public-pools source loaded it from
-- publicPoolsMetadata. read_at is when the run read it. Values arrive as decimal strings, so each is
-- cast to numeric; created_at is Unix seconds.
select
    id,
    to_timestamp((data ->> 'read_at')::bigint / 1000.0) as read_at,
    (data -> 'pool' ->> 'account_index')::bigint as account_index,
    data -> 'pool' ->> 'name' as name,
    (data -> 'pool' ->> 'account_type')::integer as account_type,
    (data -> 'pool' ->> 'master_account_index')::bigint as master_account_index,
    (data -> 'pool' ->> 'operator_fee')::numeric as operator_fee,
    (data -> 'pool' ->> 'annual_percentage_yield')::numeric as annual_percentage_yield,
    (data -> 'pool' ->> 'total_asset_value')::numeric as total_asset_value,
    (data -> 'pool' ->> 'total_spot_value')::numeric as total_spot_value,
    (data -> 'pool' ->> 'total_perps_value')::numeric as total_perps_value,
    (data -> 'pool' ->> 'total_shares')::numeric as total_shares,
    (data -> 'pool' ->> 'status')::integer as status,
    to_timestamp((data -> 'pool' ->> 'created_at')::bigint) as created_at,
    _loaded_at
from {{ source('lighter', 'public_pools') }}
