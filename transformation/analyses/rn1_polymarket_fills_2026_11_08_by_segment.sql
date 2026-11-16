-- RN1's fills and profit to payout per series, market type, role and game phase on Polygon blocks 91743315 to
-- 97042228 (2026-08-10 00:00 to 2026-11-10 00:00 UTC). Amounts are pUSD.
-- Profit to payout values each share at what it redeems for (payout_fractions) less its cost with fees, as if
-- RN1 held it to resolution; resolved_cost_usdc and pnl_usdc cover resolved markets only.
-- phase: pre_game before Gamma's game_start_time, in_game from it on, no_game_time when Gamma gives none.
-- A fill whose token Gamma lacks has no series, type or phase other than no_game_time.
with fills as (
    select
        f.*,
        m.series_slug,
        m.sports_market_type,
        m.payout_fractions[f.outcome_index + 1] as payout,
        case
            when m.game_start_time is null then 'no_game_time'
            when f.block_timestamp < m.game_start_time then 'pre_game'
            else 'in_game'
        end as phase
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
)

select
    series_slug,
    sports_market_type,
    role,
    phase,
    count(*) as fills,
    count(distinct condition_id) as markets,
    sum(shares) as shares,
    sum(usdc) as usdc,
    sum(fee_usdc) as fee_usdc,
    coalesce(sum(usdc + fee_usdc) filter (where payout is not null), 0) as resolved_cost_usdc,
    coalesce(round(sum(
        case when side = 'buy' then shares * payout - usdc - fee_usdc else usdc - fee_usdc - shares * payout end
    ), 6), 0) as pnl_usdc
from fills
group by series_slug, sports_market_type, role, phase
order by usdc desc
