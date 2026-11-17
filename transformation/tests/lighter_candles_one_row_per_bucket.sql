-- Fails when lighter_candles has more than one row for the same market, price, resolution and open time.
select market_id, price, resolution, open_time
from {{ ref('lighter_candles') }}
group by market_id, price, resolution, open_time
having count(*) > 1
