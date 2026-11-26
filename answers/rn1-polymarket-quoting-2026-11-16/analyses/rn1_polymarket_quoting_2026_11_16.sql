-- The median sum of RN1's two resting bids in one two-outcome market, in pUSD per pair, over the blocks in
-- which RN1's maker orders on both outcomes filled. Both bids rested on the book in that block, so their sum
-- is the price RN1 quoted for a full pair: 1 minus the sum is its quoted spread.
-- Each outcome's bid is the highest price at which one of RN1's maker orders on it filled in the block.
-- RN1 is the wallet 0x2005d16a84ceefa912d4e380cd32e7ff827875ea.
with tops as (
    select condition_id, block_number, outcome_index, max(round(price, 3)) as bid
    from {{ ref('polymarket_wallet_fills') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and role = 'maker'
        and outcome_index in (0, 1)
        and {{ in_window('block_number', 'polygon') }}
    group by condition_id, block_number, outcome_index
)

select percentile_cont(0.5) within group (order by a.bid + b.bid) as median_bid_sum
from tops as a
inner join tops as b
    on b.condition_id = a.condition_id and b.block_number = a.block_number and b.outcome_index = 1
where a.outcome_index = 0
