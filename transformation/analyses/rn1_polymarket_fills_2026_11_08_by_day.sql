-- RN1's fills and profit to payout per UTC day and role on Polygon blocks 91743315 to 97042228 (2026-08-10
-- 00:00 to 2026-11-10 00:00 UTC). Amounts are pUSD. Profit to payout counts on the day of the fill: each share
-- at what it redeems for (payout_fractions) less its cost with fees. resolved_cost_usdc and pnl_usdc cover
-- resolved markets only.
with fills as (
    select
        f.*,
        m.payout_fractions[f.outcome_index + 1] as payout
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
)

select
    (block_timestamp at time zone 'UTC')::date as day,
    role,
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
group by 1, role
order by 1, role
