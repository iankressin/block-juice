-- How RN1 moves its bid on one outcome from one order to the next: its maker orders on each outcome taken in
-- the order of their first fill, and the change in price from each order to the next, in cents, with the
-- blocks between their first fills. Changes beyond 5 cents are grouped.
-- An order's price is fixed, so a new price is a new order. Orders that never filled are not on chain.
-- RN1 is the wallet 0x2005d16a84ceefa912d4e380cd32e7ff827875ea.
with orders as (
    select condition_id, outcome_index, order_hash, min(block_number) as first_block, max(round(price, 3)) as price
    from {{ ref('polymarket_wallet_fills') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and role = 'maker'
        and {{ in_window('block_number', 'polygon') }}
    group by condition_id, outcome_index, order_hash
),

steps as (
    select
        100 * (price - lag(price) over w) as change_cents,
        first_block - lag(first_block) over w as blocks_between
    from orders
    window w as (partition by condition_id, outcome_index order by first_block, order_hash)
)

select
    case
        when change_cents > 5 then 'up more than 5'
        when change_cents < -5 then 'down more than 5'
        else to_char(change_cents, 'FMS990.0')
    end as change_cents,
    count(*) as orders,
    round(100.0 * count(*) / sum(count(*)) over (), 2) as pct,
    percentile_cont(0.5) within group (order by blocks_between) as median_blocks_between
from steps
where change_cents is not null
group by 1
order by orders desc
