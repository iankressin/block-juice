-- One reading of one Lighter asset, as the lighter-assets source loaded it from assetDetails.
-- read_at is when the run read it. Amounts arrive as decimal strings, so each is cast to numeric.
-- Field meanings are in catalog/vendors/lighter/NOTES.md.
select
    id,
    to_timestamp((data ->> 'read_at')::bigint / 1000.0) as read_at,
    (data -> 'asset' ->> 'asset_id')::integer as asset_id,
    data -> 'asset' ->> 'symbol' as symbol,
    (data -> 'asset' ->> 'decimals')::integer as decimals,
    (data -> 'asset' ->> 'l1_decimals')::integer as l1_decimals,
    data -> 'asset' ->> 'l1_address' as l1_address,
    data -> 'asset' ->> 'margin_mode' as margin_mode,
    (data -> 'asset' ->> 'min_transfer_amount')::numeric as min_transfer_amount,
    (data -> 'asset' ->> 'min_withdrawal_amount')::numeric as min_withdrawal_amount,
    (data -> 'asset' ->> 'loan_to_value')::numeric as loan_to_value,
    (data -> 'asset' ->> 'liquidation_threshold')::numeric as liquidation_threshold,
    (data -> 'asset' ->> 'global_supply_cap')::numeric as global_supply_cap,
    (data -> 'asset' ->> 'user_supply_cap')::numeric as user_supply_cap,
    (data -> 'asset' ->> 'index_price')::numeric as index_price,
    _loaded_at
from {{ source('lighter', 'assets') }}
