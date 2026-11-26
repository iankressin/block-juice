-- How far apart RN1 quotes the two outcomes of a market: the sum of two of its bids that rested on the book at
-- the same moment, in pUSD per pair. A sum of 0.99 is a market one tick wide: RN1's bid on one outcome and its
-- implied offer (1 minus its bid on the other) sit on adjacent cents.
-- Two kinds of proof that both bids rested at once:
--   same_block: RN1's maker orders on both outcomes filled in one block. Each side's bid is the highest
--     price that filled on it there.
--   overlapping_order: a maker fill on one outcome came while an order on the other outcome was between its
--     first and last fill, so still on the book. One row per fill and live order.
-- phase compares the block time with Gamma's game_start_time. RN1 is 0x2005d16a84ceefa912d4e380cd32e7ff827875ea.
with fills as (
    select f.condition_id, f.block_number, f.block_timestamp, f.outcome_index, f.order_hash, round(f.price, 3) as price
    from {{ ref('polymarket_wallet_fills') }} as f
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.role = 'maker'
        and f.outcome_index in (0, 1)
        and {{ in_window('f.block_number', 'polygon') }}
),

tops as (
    select condition_id, block_number, min(block_timestamp) as block_timestamp, outcome_index, max(price) as bid
    from fills
    group by condition_id, block_number, outcome_index
),

same_block as (
    select 'same_block' as evidence, a.condition_id, a.block_timestamp, a.bid + b.bid as bid_sum
    from tops as a
    inner join tops as b
        on b.condition_id = a.condition_id and b.block_number = a.block_number and b.outcome_index = 1
    where a.outcome_index = 0
),

orders as (
    select condition_id, outcome_index, order_hash, max(price) as price, min(block_number) as first_block, max(block_number) as last_block
    from fills
    group by condition_id, outcome_index, order_hash
    having max(block_number) > min(block_number)
),

overlapping as (
    select distinct on (f.condition_id, f.block_number, f.order_hash, o.order_hash)
        'overlapping_order' as evidence, f.condition_id, f.block_timestamp, f.price + o.price as bid_sum
    from fills as f
    inner join orders as o
        on o.condition_id = f.condition_id
        and o.outcome_index <> f.outcome_index
        and f.block_number between o.first_block and o.last_block
),

pairs as (
    select p.*, case when p.block_timestamp < m.game_start_time then 'pre_game' when m.game_start_time is not null then 'in_game' else 'unknown' end as phase
    from (select * from same_block union all select * from overlapping) as p
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = p.condition_id
)

select
    evidence,
    coalesce(phase, 'all') as phase,
    count(*) as pairs,
    count(distinct condition_id) as markets,
    round(avg(bid_sum), 4) as avg_bid_sum,
    percentile_cont(0.05) within group (order by bid_sum) as p05,
    percentile_cont(0.25) within group (order by bid_sum) as p25,
    percentile_cont(0.5) within group (order by bid_sum) as median,
    percentile_cont(0.75) within group (order by bid_sum) as p75,
    percentile_cont(0.95) within group (order by bid_sum) as p95,
    round(100.0 * avg((bid_sum = 0.99)::int), 2) as pct_one_tick,
    round(100.0 * avg((bid_sum < 0.99)::int), 2) as pct_wider,
    round(100.0 * avg((bid_sum > 0.99 and bid_sum < 1)::int), 2) as pct_sub_tick,
    round(100.0 * avg((bid_sum >= 1)::int), 2) as pct_at_or_above_1
from pairs
group by grouping sets ((evidence), (evidence, phase))
order by evidence, phase nulls first
