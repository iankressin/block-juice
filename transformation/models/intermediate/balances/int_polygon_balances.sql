-- Polygon ERC-20 balances in the shape latest_balances reads. Reverted calls have a null balance and are
-- left out.
select
    id,
    'polygon' as chain,
    wallet,
    'erc20' as asset_type,
    token as asset,
    block_number,
    balance,
    _loaded_at
from {{ ref('stg_polygon__erc20_balances') }}
where balance is not null
