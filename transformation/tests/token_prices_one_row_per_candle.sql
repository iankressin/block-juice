-- Fails when token_prices has more than one row for the same token, quote, interval and open time.
select token, quote, interval, open_time
from {{ ref('token_prices') }}
group by token, quote, interval, open_time
having count(*) > 1
