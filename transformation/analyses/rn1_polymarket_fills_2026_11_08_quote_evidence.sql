-- Evidence on how RN1 places its orders, from its fills alone, on Polygon blocks 91743315 to 97042228
-- (2026-08-10 00:00 to 2026-11-10 00:00 UTC). One row per measure: n out of total, or a plain value.
-- Resting orders that never filled, and cancels, are off chain and not in it.
--   A sweep is one transaction's maker fills on one token: one taker order matched against RN1's orders.
--   A maker fill's price is the limit price of RN1's order; prices are rounded to 4 decimals to count levels.
--   An order is one order_hash; its size here is what filled, a floor on what RN1 posted.
with fills as (
    select f.*, round(f.price, 4) as px
    from {{ ref('polymarket_wallet_fills') }} as f
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
),

maker as (
    select * from fills where role = 'maker'
),

sweeps as (
    select tx_hash, token_id, count(*) as fills, count(distinct order_hash) as orders, count(distinct px) as prices
    from maker
    group by tx_hash, token_id
),

orders as (
    select
        order_hash,
        role,
        count(*) as fills,
        sum(shares) as shares,
        sum(usdc) as usdc,
        extract(epoch from max(block_timestamp) - min(block_timestamp)) as span_s
    from fills
    group by order_hash, role
),

maker_block_tokens as (
    select distinct block_number, token_id from maker
),

paired_maker as (
    select
        m.id,
        o.token_id is not null as other_side_same_block
    from maker as m
    left join maker_block_tokens as o
        on o.block_number = m.block_number and o.token_id = m.complement_token_id
    where m.complement_token_id is not null
),

minutes as (
    select
        condition_id,
        date_trunc('minute', block_timestamp) as minute,
        count(distinct outcome_index) as outcomes,
        count(*) as fills
    from maker
    where complement_token_id is not null
    group by 1, 2
),

levels as (
    select
        condition_id,
        outcome_index,
        floor(extract(epoch from block_timestamp) / 300) as five_minutes,
        count(distinct px) as levels
    from maker
    where complement_token_id is not null
    group by 1, 2, 3
),

order_roles as (
    select order_hash, bool_or(role = 'taker') as took, bool_or(role = 'maker') as rested
    from fills
    group by order_hash
),

in_market_order as (
    select
        role,
        count(*) filter (where role = 'maker') over (
            partition by condition_id order by block_number, log_index
            rows between unbounded preceding and 1 preceding
        ) as maker_fills_before
    from fills
    where condition_id is not null
),

measures as (
    select 1 as ord, 'sweeps that filled 2 or more of RN1''s orders' as measure,
        count(*) filter (where orders >= 2) as n, count(*) as total, null::numeric as value
    from sweeps
    union all
    select 2, 'of those sweeps, the ones that filled 2 or more price levels',
        count(*) filter (where prices >= 2), count(*) filter (where orders >= 2), null
    from sweeps
    union all
    select 3, 'maker fills that came in a sweep across 2 or more price levels',
        coalesce(sum(fills) filter (where prices >= 2), 0), sum(fills), null
    from sweeps
    union all
    select 4, 'maker fills priced on a whole cent',
        count(*) filter (where abs(price * 100 - round(price * 100)) < 0.01), count(*), null
    from maker
    union all
    select 5, 'maker fills priced on a tenth of a cent',
        count(*) filter (where abs(price * 1000 - round(price * 1000)) < 0.01), count(*), null
    from maker
    union all
    select 6, 'maker fills in a block where RN1''s order on the other outcome also filled',
        count(*) filter (where other_side_same_block), count(*), null
    from paired_maker
    union all
    select 7, 'market-minutes with maker fills on both outcomes',
        count(*) filter (where outcomes = 2), count(*), null
    from minutes
    union all
    select 8, 'maker fills in a minute when both outcomes filled',
        coalesce(sum(fills) filter (where outcomes = 2), 0), sum(fills), null
    from minutes
    union all
    select 9, 'maker orders filled in 2 or more fills',
        count(*) filter (where fills >= 2), count(*), null
    from orders where role = 'maker'
    union all
    select 10, 'multi-fill maker orders whose fills span 60 seconds or more',
        count(*) filter (where span_s >= 60), count(*), null
    from orders where role = 'maker' and fills >= 2
    union all
    select 11, 'multi-fill maker orders whose fills span 10 minutes or more',
        count(*) filter (where span_s >= 600), count(*), null
    from orders where role = 'maker' and fills >= 2
    union all
    select 12, 'taker orders filled for a whole number of shares',
        count(*) filter (where abs(shares - round(shares)) < 0.000001), count(*), null
    from orders where role = 'taker'
    union all
    select 13, 'taker orders filled for a whole number of pUSD',
        count(*) filter (where abs(usdc - round(usdc)) < 0.000001), count(*), null
    from orders where role = 'taker'
    union all
    select 14, 'maker orders filled for a whole number of shares',
        count(*) filter (where abs(shares - round(shares)) < 0.000001), count(*), null
    from orders where role = 'maker'
    union all
    select 15, 'maker price levels filled per market, outcome and 5 minutes, median',
        null, count(*), percentile_cont(0.5) within group (order by levels)::numeric
    from levels
    union all
    select 16, 'maker price levels filled per market, outcome and 5 minutes, 90th percentile',
        null, count(*), percentile_cont(0.9) within group (order by levels)::numeric
    from levels
    union all
    select 17, 'shares filled per maker order, median',
        null, count(*), percentile_cont(0.5) within group (order by shares)::numeric
    from orders where role = 'maker'
    union all
    select 18, 'shares filled per maker order, 90th percentile',
        null, count(*), percentile_cont(0.9) within group (order by shares)::numeric
    from orders where role = 'maker'
    union all
    select 19, 'shares filled per maker order, 99th percentile',
        null, count(*), percentile_cont(0.99) within group (order by shares)::numeric
    from orders where role = 'maker'
    union all
    select 20, 'shares filled per taker order, median',
        null, count(*), percentile_cont(0.5) within group (order by shares)::numeric
    from orders where role = 'taker'
    union all
    select 21, 'shares filled per taker order, 90th percentile',
        null, count(*), percentile_cont(0.9) within group (order by shares)::numeric
    from orders where role = 'taker'
    union all
    select 22, 'shares filled per taker order, 99th percentile',
        null, count(*), percentile_cont(0.99) within group (order by shares)::numeric
    from orders where role = 'taker'
    union all
    select 23, 'taker orders that also rested on the book and filled as maker',
        count(*) filter (where took and rested), count(*) filter (where took), null
    from order_roles
    union all
    select 24, 'taker fills in a market where one of RN1''s resting orders had filled earlier',
        count(*) filter (where maker_fills_before > 0), count(*), null
    from in_market_order where role = 'taker'
)

select
    ord,
    measure,
    n,
    total,
    round(100.0 * n / nullif(total, 0), 2) as pct,
    round(value, 6) as value
from measures
order by ord
