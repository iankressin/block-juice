-- One Lighter asset as of the latest run that read it. An asset's settings can change between runs, so
-- each asset keeps the row with the latest read_at. decimals scales a balance to integer units.
select distinct on (asset_id)
    asset_id,
    symbol,
    decimals,
    l1_decimals,
    l1_address,
    margin_mode,
    min_transfer_amount,
    min_withdrawal_amount,
    loan_to_value,
    liquidation_threshold,
    global_supply_cap,
    user_supply_cap,
    index_price,
    read_at
from {{ ref('stg_lighter__assets') }}
order by asset_id, read_at desc
