-- RN1's profit to payout per two-outcome market on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00 to
-- 2026-11-10 00:00 UTC), split into its complete pairs and its unmatched shares. Amounts are pUSD.
-- Profit to payout values each share RN1 bought in the window at what it redeems for (payout_fractions), less
-- what it cost with fees, as if RN1 held every share to resolution. A merged pair pays 1 pUSD, the same as the
-- two payouts, so merges do not change it. Null until the market resolves.
-- pair_pnl_usdc is pair_shares * (1 - pair_cost), the pair edge of the by_market analysis, priced at each
-- outcome's average cost after fees; unmatched_pnl_usdc is the rest of pnl_usdc.
-- participant_pnl_usdc is RN1's pnl_usdc in polymarket_market_participants, which also counts splits, merges,
-- redemptions and transfers, and what came before the window in markets whose history it has.
with fills as (
    select
        f.*,
        m.payout_fractions[f.outcome_index + 1] as payout
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
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
        sum(case when side = 'buy' then shares * payout - usdc - fee_usdc else usdc - fee_usdc - shares * payout end)
            as pnl_usdc
    from fills
    group by condition_id
),

priced as (
    select
        *,
        least(shares_0, shares_1) as pair_shares,
        cost_0 / nullif(shares_0, 0) + cost_1 / nullif(shares_1, 0) as pair_cost
    from per_market
)

select
    p.condition_id,
    m.question,
    m.series_slug,
    m.sports_market_type,
    m.game_start_time,
    m.resolved_at,
    m.payout_fractions[1] as payout_0,
    m.payout_fractions[2] as payout_1,
    p.fills,
    p.maker_fills,
    p.cost_0 + p.cost_1 as cost_usdc,
    p.pair_shares,
    round(p.pair_cost, 6) as pair_cost,
    abs(p.shares_0 - p.shares_1) as unmatched_shares,
    case when p.shares_0 > p.shares_1 then 0 when p.shares_1 > p.shares_0 then 1 end as unmatched_outcome_index,
    round(p.pnl_usdc, 6) as pnl_usdc,
    round(coalesce(p.pair_shares * (1 - p.pair_cost), 0), 6) as pair_pnl_usdc,
    round(p.pnl_usdc - coalesce(p.pair_shares * (1 - p.pair_cost), 0), 6) as unmatched_pnl_usdc,
    round(pp.pnl_usdc, 6) as participant_pnl_usdc
from priced as p
left join {{ ref('polymarket_markets') }} as m on m.condition_id = p.condition_id
left join {{ ref('polymarket_market_participants') }} as pp
    on pp.condition_id = p.condition_id
    and pp.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
order by p.cost_0 + p.cost_1 desc
