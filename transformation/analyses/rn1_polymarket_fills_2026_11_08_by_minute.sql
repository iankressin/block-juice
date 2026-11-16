-- RN1's fills per five minutes from game start and role, in two-outcome markets with a Gamma game_start_time,
-- on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00 to 2026-11-10 00:00 UTC). Amounts are pUSD.
-- minute_bucket is the fill's minutes since game_start_time, floored to 5: 0 holds the game's first five
-- minutes, -5 the five before it. -60 gathers everything an hour or more before, 300 everything five hours or
-- more after. payout_usdc and pnl_usdc are as in the by_price analysis: resolved markets only, each share at
-- what it redeems for, pnl after fees.
with fills as (
    select
        f.*,
        m.payout_fractions[f.outcome_index + 1] as payout,
        extract(epoch from f.block_timestamp - m.game_start_time) / 60 as minutes
    from {{ ref('polymarket_wallet_fills') }} as f
    inner join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and f.complement_token_id is not null
        and m.game_start_time is not null
        and f.side = 'buy'
)

select
    greatest(-60, least(300, floor(minutes / 5) * 5))::int as minute_bucket,
    role,
    count(*) as fills,
    count(distinct condition_id) as markets,
    sum(shares) as shares,
    sum(usdc) as usdc,
    round(sum(usdc) / nullif(sum(shares), 0), 6) as avg_price,
    coalesce(sum(shares) filter (where payout is not null), 0) as resolved_shares,
    coalesce(sum(usdc + fee_usdc) filter (where payout is not null), 0) as resolved_cost_usdc,
    coalesce(round(sum(shares * payout), 6), 0) as payout_usdc,
    coalesce(round(sum(shares * payout - usdc - fee_usdc), 6), 0) as pnl_usdc
from fills
group by 1, role
order by 1, role
