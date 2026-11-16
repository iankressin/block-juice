-- Who took RN1's resting orders on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00 to 2026-11-10 00:00
-- UTC): the 50 takers with the most of RN1's maker fills, then one row for all the others. Amounts are pUSD.
-- pnl_usdc is RN1's profit to payout on those fills (resolved markets only, each share at what it redeems for,
-- after fees); the taker made the opposite, before its own fees. markets is null on the all-others row.
with fills as (
    select
        f.*,
        m.payout_fractions[f.outcome_index + 1] as payout
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and f.role = 'maker'
),

per_taker as (
    select
        counterparty,
        count(*) as fills,
        count(distinct condition_id) as markets,
        sum(shares) as shares,
        sum(usdc) as usdc,
        coalesce(sum(usdc + fee_usdc) filter (where payout is not null), 0) as resolved_cost_usdc,
        coalesce(sum(
            case when side = 'buy' then shares * payout - usdc - fee_usdc else usdc - fee_usdc - shares * payout end
        ), 0) as pnl_usdc
    from fills
    group by counterparty
),

ranked as (
    select *, row_number() over (order by fills desc, counterparty) as rank
    from per_taker
)

select
    case when rank <= 50 then rank end as rank,
    case when rank <= 50 then counterparty else 'all others' end as counterparty,
    count(*) as takers,
    sum(fills) as fills,
    case when min(rank) <= 50 then sum(markets) end as markets,
    sum(shares) as shares,
    sum(usdc) as usdc,
    sum(resolved_cost_usdc) as resolved_cost_usdc,
    round(sum(pnl_usdc), 6) as pnl_usdc
from ranked
group by 1, 2
order by rank nulls last
