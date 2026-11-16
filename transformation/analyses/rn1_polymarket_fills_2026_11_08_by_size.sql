-- RN1's fills per fill size and role on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00 to 2026-11-10
-- 00:00 UTC). size_from is the band's lowest share count; a band runs to the next one. Amounts are pUSD.
-- payout_usdc and pnl_usdc are as in the by_price analysis: resolved markets only, each share at what it
-- redeems for, pnl after fees.
with fills as (
    select
        f.*,
        m.payout_fractions[f.outcome_index + 1] as payout
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and f.side = 'buy'
),

banded as (
    select
        *,
        case
            when shares < 1 then 0
            when shares < 5 then 1
            when shares < 10 then 5
            when shares < 25 then 10
            when shares < 50 then 25
            when shares < 100 then 50
            when shares < 250 then 100
            when shares < 500 then 250
            when shares < 1000 then 500
            when shares < 2500 then 1000
            when shares < 5000 then 2500
            when shares < 10000 then 5000
            else 10000
        end as size_from
    from fills
)

select
    size_from,
    role,
    count(*) as fills,
    sum(shares) as shares,
    sum(usdc) as usdc,
    round(sum(usdc) / nullif(sum(shares), 0), 6) as avg_price,
    coalesce(sum(shares) filter (where payout is not null), 0) as resolved_shares,
    coalesce(sum(usdc + fee_usdc) filter (where payout is not null), 0) as resolved_cost_usdc,
    coalesce(round(sum(shares * payout), 6), 0) as payout_usdc,
    coalesce(round(sum(shares * payout - usdc - fee_usdc), 6), 0) as pnl_usdc
from banded
group by size_from, role
order by size_from, role
