-- Polymarket volume in the loaded window: pUSD paid or received in maker-order fills, before fees.
select sum(usdc) as volume_usdc
from {{ ref('polymarket_trades') }}
