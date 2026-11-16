-- RN1's profit to payout per UTC day, role and game phase on Polygon blocks 91743315 to 97042228 (2026-08-10
-- 00:00 to 2026-11-10 00:00 UTC), to judge how steady each of the four strategies is. Amounts are pUSD.
-- phase: pre_game before Gamma's game_start_time, in_game from it on; fills in markets with no game time are
-- left out. Profit counts on the day of the fill: resolved markets only, each share at what it redeems for
-- (payout_fractions) less its cost with fees.
with fills as (
    select
        f.*,
        m.payout_fractions[f.outcome_index + 1] as payout,
        case when f.block_timestamp < m.game_start_time then 'pre_game' else 'in_game' end as phase
    from {{ ref('polymarket_wallet_fills') }} as f
    inner join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and m.game_start_time is not null
)

select
    (block_timestamp at time zone 'UTC')::date as day,
    role,
    phase,
    count(*) as fills,
    count(distinct condition_id) as markets,
    sum(usdc) as usdc,
    coalesce(sum(usdc + fee_usdc) filter (where payout is not null), 0) as resolved_cost_usdc,
    coalesce(round(sum(
        case when side = 'buy' then shares * payout - usdc - fee_usdc else usdc - fee_usdc - shares * payout end
    ), 6), 0) as pnl_usdc
from fills
group by 1, role, phase
order by 1, role, phase
