-- How RN1 spaces its bids on one outcome: in each block where its maker orders on one outcome filled at two or
-- more prices, the gap in pUSD between each price and the next lower one. Several prices filling in one block
-- means several of RN1's bids rested at once, one under the other.
-- RN1 is the wallet 0x2005d16a84ceefa912d4e380cd32e7ff827875ea.
with levels as (
    select distinct condition_id, outcome_index, block_number, round(price, 3) as price
    from {{ ref('polymarket_wallet_fills') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and role = 'maker'
        and {{ in_window('block_number', 'polygon') }}
),

gaps as (
    select price - lead(price) over (partition by condition_id, outcome_index, block_number order by price desc) as gap
    from levels
)

select
    gap,
    count(*) as level_pairs,
    round(100.0 * count(*) / sum(count(*)) over (), 2) as pct
from gaps
where gap is not null
group by gap
order by level_pairs desc, gap
