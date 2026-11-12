-- RN1's complementary accumulation per two-outcome market on Polygon in the answer's window. Amounts are
-- pUSD; shares are outcome tokens.
-- Per outcome (outcome_index 0 and 1): the shares RN1 bought and what they cost, fees included, so
-- avg_cost is pUSD per share after fees.
-- A complete pair is one share of each outcome; it redeems or merges for exactly 1 pUSD.
--   pair_shares = least(shares_0, shares_1), the pairs RN1 could merge from this window's buys alone.
--   pair_cost = avg_cost_0 + avg_cost_1, the cost of one pair at the window's average prices.
--   pair_edge_usdc = pair_shares * (1 - pair_cost): the profit locked in by those pairs, before any
--   disposal. It is negative when a pair cost more than 1.
--   unmatched_shares sit on unmatched_outcome: directional exposure, worth its payout at resolution.
-- Only buys count; sold_shares shows what RN1 sold per market, which the pair figures leave out. Markets
-- with more than two outcomes have no complement token and stay out. game_start_time comes from Gamma.
with fills as (
    select f.*
    from {{ ref('polymarket_wallet_fills') }} as f
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('f.block_number', 'polygon') }}
        and f.complement_token_id is not null
),

per_market as (
    select
        condition_id,
        count(*) as fills,
        count(*) filter (where role = 'maker') as maker_fills,
        coalesce(sum(shares) filter (where side = 'buy' and outcome_index = 0), 0) as shares_0,
        coalesce(sum(usdc + fee_usdc) filter (where side = 'buy' and outcome_index = 0), 0) as cost_0,
        coalesce(sum(shares) filter (where side = 'buy' and outcome_index = 1), 0) as shares_1,
        coalesce(sum(usdc + fee_usdc) filter (where side = 'buy' and outcome_index = 1), 0) as cost_1,
        coalesce(sum(shares) filter (where side = 'sell'), 0) as sold_shares,
        min(block_timestamp) as first_fill_at,
        max(block_timestamp) as last_fill_at
    from fills
    group by condition_id
),

priced as (
    select
        *,
        round(cost_0 / nullif(shares_0, 0), 6) as avg_cost_0,
        round(cost_1 / nullif(shares_1, 0), 6) as avg_cost_1,
        least(shares_0, shares_1) as pair_shares
    from per_market
)

select
    p.condition_id,
    m.question,
    m.event_title,
    m.is_sports,
    m.sports_market_type,
    m.series_slug,
    m.game_start_time,
    m.outcomes,
    p.fills,
    p.maker_fills,
    p.shares_0,
    p.cost_0,
    p.avg_cost_0,
    p.shares_1,
    p.cost_1,
    p.avg_cost_1,
    p.sold_shares,
    p.pair_shares,
    p.shares_0 > 0 and p.shares_1 > 0 as bought_both,
    p.avg_cost_0 + p.avg_cost_1 as pair_cost,
    round(p.pair_shares * (1 - (p.avg_cost_0 + p.avg_cost_1)), 6) as pair_edge_usdc,
    abs(p.shares_0 - p.shares_1) as unmatched_shares,
    case when p.shares_0 > p.shares_1 then m.outcomes[1] when p.shares_1 > p.shares_0 then m.outcomes[2] end
        as unmatched_outcome,
    round(
        case
            when p.shares_0 > p.shares_1 then (p.shares_0 - p.shares_1) * p.avg_cost_0
            when p.shares_1 > p.shares_0 then (p.shares_1 - p.shares_0) * p.avg_cost_1
            else 0
        end, 6
    ) as unmatched_cost_usdc,
    p.first_fill_at,
    p.last_fill_at
from priced as p
left join {{ ref('polymarket_markets') }} as m on m.condition_id = p.condition_id
order by p.cost_0 + p.cost_1 desc
