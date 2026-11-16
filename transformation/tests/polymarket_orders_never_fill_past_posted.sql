-- Fails for each order whose loaded fills took more of its maker asset than its owner posted.
select order_hash
from {{ ref('int_polygon_polymarket_ctf_exchange_v2_orders') }}
group by order_hash
having sum(maker_amount_filled) > max(maker_amount)
