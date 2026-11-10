-- Lists each Polymarket trade whose price is not in (0, 1]. A share pays at most 1 pUSD, and a fill
-- trades shares for some pUSD, so a price outside that range, or none, means the fills model read the
-- amounts wrong.
select id, token_id, shares, usdc, price
from {{ ref('polymarket_trades') }}
where price is null or price <= 0 or price > 1
