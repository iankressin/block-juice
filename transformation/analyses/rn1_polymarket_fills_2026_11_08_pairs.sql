-- RN1's complementary accumulation summed over its two-outcome markets, per market kind (sports or not,
-- from Gamma), on Polygon in the answer's window. Amounts are pUSD.
-- The per-market figures and their rules are in rn1_polymarket_fills_2026_11_08_by_market.sql:
-- pair_shares = least(shares bought of each outcome), pair_cost = the sum of the two average costs after
-- fees, pair_edge = pair_shares * (1 - pair_cost). pairs_below_1_pct weights each market by its pairs.
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
        coalesce(sum(shares) filter (where side = 'buy' and outcome_index = 0), 0) as shares_0,
        coalesce(sum(usdc + fee_usdc) filter (where side = 'buy' and outcome_index = 0), 0) as cost_0,
        coalesce(sum(shares) filter (where side = 'buy' and outcome_index = 1), 0) as shares_1,
        coalesce(sum(usdc + fee_usdc) filter (where side = 'buy' and outcome_index = 1), 0) as cost_1
    from fills
    group by condition_id
),

priced as (
    select
        p.*,
        case when m.is_sports then 'sports' when m.is_sports is not null then 'other' else 'unknown' end as kind,
        least(p.shares_0, p.shares_1) as pair_shares,
        p.cost_0 / nullif(p.shares_0, 0) + p.cost_1 / nullif(p.shares_1, 0) as pair_cost,
        case
            when p.shares_0 > p.shares_1 then (p.shares_0 - p.shares_1) * p.cost_0 / p.shares_0
            when p.shares_1 > p.shares_0 then (p.shares_1 - p.shares_0) * p.cost_1 / p.shares_1
            else 0
        end as unmatched_cost
    from per_market as p
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = p.condition_id
)

select
    kind,
    count(*) as markets,
    count(*) filter (where pair_shares > 0) as markets_bought_both,
    round(100.0 * count(*) filter (where pair_shares > 0) / count(*), 2) as markets_bought_both_pct,
    sum(cost_0 + cost_1) as cost_usdc,
    sum(pair_shares) as pair_shares,
    round(sum(pair_shares * pair_cost) filter (where pair_shares > 0), 6) as pair_cost_usdc,
    round(sum(pair_shares * pair_cost) filter (where pair_shares > 0) / nullif(sum(pair_shares), 0), 6)
        as avg_pair_cost,
    count(*) filter (where pair_shares > 0 and pair_cost < 1) as markets_pair_below_1,
    round(100.0 * sum(pair_shares) filter (where pair_cost < 1) / nullif(sum(pair_shares), 0), 2)
        as pairs_below_1_pct,
    round(sum(pair_shares * (1 - pair_cost)) filter (where pair_shares > 0), 6) as pair_edge_usdc,
    sum(abs(shares_0 - shares_1)) as unmatched_shares,
    round(sum(unmatched_cost), 6) as unmatched_cost_usdc
from priced
group by rollup (kind)
order by kind nulls last
