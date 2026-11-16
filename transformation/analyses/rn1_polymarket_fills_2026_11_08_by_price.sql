-- RN1's fills per price cent and role on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00 to 2026-11-10
-- 00:00 UTC), with what the shares paid at resolution. Prices and amounts are pUSD.
-- price_cent is floor(price * 100): 47 holds fills priced 0.47 to 0.479999.
-- payout_usdc is what the shares bought in resolved markets redeem for (payout_fractions); payout_usdc /
-- resolved_shares is the share of them that won, to set against the price paid. pnl_usdc is payout_usdc less
-- resolved_cost_usdc, the cost with fees.
with fills as (
    select
        f.*,
        m.payout_fractions[f.outcome_index + 1] as payout
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and f.side = 'buy'
)

select
    least(floor(price * 100), 99)::int as price_cent,
    role,
    count(*) as fills,
    sum(shares) as shares,
    sum(usdc) as usdc,
    sum(fee_usdc) as fee_usdc,
    coalesce(sum(shares) filter (where payout is not null), 0) as resolved_shares,
    coalesce(sum(usdc + fee_usdc) filter (where payout is not null), 0) as resolved_cost_usdc,
    coalesce(round(sum(shares * payout), 6), 0) as payout_usdc,
    coalesce(round(sum(shares * payout - usdc - fee_usdc), 6), 0) as pnl_usdc
from fills
group by 1, role
order by 1, role
