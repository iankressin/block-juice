-- Fails when polymarket_market_participants has more than one row for the same market and wallet.
select condition_id, wallet
from {{ ref('polymarket_market_participants') }}
group by condition_id, wallet
having count(*) > 1
