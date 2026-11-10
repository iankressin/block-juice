-- Fails when polymarket_price_candles has more than one row for the same token and minute.
select token_id, minute
from {{ ref('polymarket_price_candles') }}
group by token_id, minute
having count(*) > 1
