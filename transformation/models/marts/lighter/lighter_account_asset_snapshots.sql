-- One asset balance of one Lighter account in one reading, in the asset's own units.
select
    id,
    account_index,
    read_at,
    asset_id,
    symbol,
    balance,
    locked_balance,
    margin_balance,
    margin_mode
from {{ ref('int_lighter_account_asset_snapshots') }}
