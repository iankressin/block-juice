-- Whether RN1 widens its quotes when its holdings in a market are lopsided: the sum of its two bids in the
-- blocks where both filled (as in rn1_polymarket_quoting_2026_11_16_bid_sums.sql, same_block), against the gap
-- in shares between the two outcomes it held just before that block.
-- Holdings count every buy RN1 made in the window (maker and taker); merges remove equal shares of both
-- outcomes and leave the gap as it is. Shares held before the window are not counted.
-- RN1 is the wallet 0x2005d16a84ceefa912d4e380cd32e7ff827875ea.
with fills as (
    select condition_id, block_number, outcome_index, role, round(price, 3) as price, shares
    from {{ ref('polymarket_wallet_fills') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and side = 'buy'
        and outcome_index in (0, 1)
        and {{ in_window('block_number', 'polygon') }}
),

-- The gap held at the start of each block with a fill: everything bought in earlier blocks.
holdings as (
    select
        condition_id,
        block_number,
        abs(
            coalesce(sum(sum(shares) filter (where outcome_index = 0)) over w, 0)
            - coalesce(sum(sum(shares) filter (where outcome_index = 1)) over w, 0)
        ) as gap_shares
    from fills
    group by condition_id, block_number
    window w as (partition by condition_id order by block_number rows between unbounded preceding and 1 preceding)
),

tops as (
    select condition_id, block_number, outcome_index, max(price) as bid
    from fills
    where role = 'maker'
    group by condition_id, block_number, outcome_index
),

pairs as (
    select a.condition_id, a.block_number, a.bid + b.bid as bid_sum
    from tops as a
    inner join tops as b
        on b.condition_id = a.condition_id and b.block_number = a.block_number and b.outcome_index = 1
    where a.outcome_index = 0
)

select
    case
        when h.gap_shares = 0 then '0 level'
        when h.gap_shares < 500 then '1 under 500'
        when h.gap_shares < 2000 then '2 500 to 2,000'
        when h.gap_shares < 10000 then '3 2,000 to 10,000'
        else '4 10,000 or more'
    end as holdings_gap_shares,
    count(*) as blocks,
    round(avg(p.bid_sum), 4) as avg_bid_sum,
    percentile_cont(0.5) within group (order by p.bid_sum) as median_bid_sum,
    round(100.0 * avg((p.bid_sum = 0.99)::int), 2) as pct_one_tick,
    round(100.0 * avg((p.bid_sum < 0.99)::int), 2) as pct_wider
from pairs as p
inner join holdings as h on h.condition_id = p.condition_id and h.block_number = p.block_number
group by 1
order by 1
