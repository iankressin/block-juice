-- Fails when the fills of one order hash were matched to signed orders that differ. The hash commits to every
-- signed field (catalog/protocols/polymarket/NOTES.md, Q12), so a difference means a fill was matched to the
-- wrong order of its transaction.
select order_hash
from {{ ref('int_polygon_polymarket_ctf_exchange_v2_orders') }}
group by order_hash
having count(distinct (maker, signer, token_id, side, maker_amount, taker_amount, salt, signed_at)) > 1
