-- The most common sizes of RN1's orders, by what filled, on Polygon blocks 91743315 to 97042228 (2026-08-10
-- 00:00 to 2026-11-10 00:00 UTC): per role, the 12 most common share totals and the 12 most common pUSD
-- totals (before fees), each rounded to 2 decimals. An order is one order_hash. What filled is a floor on
-- what RN1 posted: a maker order's fills depend on the takers' sizes.
with fills as (
    select f.*
    from {{ ref('polymarket_wallet_fills') }} as f
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
),

orders as (
    select order_hash, role, sum(shares) as shares, sum(usdc) as usdc
    from fills
    group by order_hash, role
),

sizes as (
    select role, 'shares' as unit, round(shares, 2) as size, count(*) as orders from orders group by 1, 3
    union all
    select role, 'pusd' as unit, round(usdc, 2) as size, count(*) as orders from orders group by 1, 3
),

ranked as (
    select
        *,
        row_number() over (partition by role, unit order by orders desc, size) as rank,
        sum(orders) over (partition by role, unit) as total
    from sizes
)

select
    role,
    unit,
    rank,
    size,
    orders,
    round(100.0 * orders / total, 2) as pct_of_orders
from ranked
where rank <= 12
order by role, unit, rank
