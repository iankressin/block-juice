-- RN1's buys in two-outcome markets by how lopsided its position was just before each fill, on Polygon blocks
-- 91743315 to 97042228 (2026-08-10 00:00 to 2026-11-10 00:00 UTC). Amounts are pUSD.
-- The position counts what RN1 bought in this window, fill by fill in (block, log index) order; merges, which
-- remove equal shares of both outcomes, are not in it. The gap is |held_this - held_other| over their sum.
-- inventory_side: underweight when RN1 held fewer shares of the bought outcome than of the other, overweight
-- when more, level when equal (both 0 at a market's first fill).
-- pnl_usdc is profit to payout: resolved markets only, each share at what it redeems for, after fees.
with fills as (
    select
        f.*,
        m.payout_fractions[f.outcome_index + 1] as payout
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and f.complement_token_id is not null
        and f.side = 'buy'
),

running as (
    select
        *,
        coalesce(sum(shares) filter (where outcome_index = 0) over w, 0)
            - case when outcome_index = 0 then shares else 0 end as held_0,
        coalesce(sum(shares) filter (where outcome_index = 1) over w, 0)
            - case when outcome_index = 1 then shares else 0 end as held_1
    from fills
    window w as (partition by condition_id order by block_number, log_index rows unbounded preceding)
),

sided as (
    select
        *,
        case when outcome_index = 0 then held_0 else held_1 end as held_this,
        case when outcome_index = 0 then held_1 else held_0 end as held_other
    from running
)

select
    role,
    case
        when held_this = 0 and held_other = 0 then '0: no position yet'
        when held_this = 0 or held_other = 0 then '5: one outcome only'
        when abs(held_this - held_other) / (held_this + held_other) < 0.10 then '1: gap under 10%'
        when abs(held_this - held_other) / (held_this + held_other) < 0.25 then '2: gap 10 to 25%'
        when abs(held_this - held_other) / (held_this + held_other) < 0.50 then '3: gap 25 to 50%'
        else '4: gap 50% or more'
    end as imbalance_band,
    case
        when held_this = held_other then 'level'
        when held_this < held_other then 'underweight'
        else 'overweight'
    end as inventory_side,
    count(*) as fills,
    sum(shares) as shares,
    sum(usdc) as usdc,
    coalesce(sum(usdc + fee_usdc) filter (where payout is not null), 0) as resolved_cost_usdc,
    coalesce(round(sum(shares * payout - usdc - fee_usdc), 6), 0) as pnl_usdc
from sided
group by 1, 2, 3
order by 1, 2, 3
