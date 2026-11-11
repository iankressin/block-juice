-- RN1's fills in two-outcome markets by game phase on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00
-- to 2026-11-10 00:00 UTC), with how it balances inventory. Shares are outcome tokens; prices pUSD per share.
-- phase: pre_game before Gamma's game_start_time, in_game from it on, no_game_time when Gamma gives none.
-- Inventory is what RN1 bought in this window only, fill by fill in (block, log index) order; holdings
-- from before the window are not in it. A buy is of the underweight outcome when RN1 held fewer shares
-- of that outcome than of the other just before it; balanced when it held equal amounts (at the first
-- fill of a market, both are 0).
with fills as (
    select
        f.*,
        m.game_start_time,
        case
            when m.game_start_time is null then 'no_game_time'
            when f.block_timestamp < m.game_start_time then 'pre_game'
            else 'in_game'
        end as phase
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and f.complement_token_id is not null
),

running as (
    select
        *,
        coalesce(sum(case when side = 'buy' then shares else -shares end) filter (where outcome_index = 0) over w, 0)
            - case when outcome_index = 0 then (case when side = 'buy' then shares else -shares end) else 0 end
            as held_0_before,
        coalesce(sum(case when side = 'buy' then shares else -shares end) filter (where outcome_index = 1) over w, 0)
            - case when outcome_index = 1 then (case when side = 'buy' then shares else -shares end) else 0 end
            as held_1_before
    from fills
    window w as (partition by condition_id order by block_number, log_index rows unbounded preceding)
),

classified as (
    select
        *,
        case
            when side <> 'buy' then 'sell'
            when held_0_before = held_1_before then 'balanced'
            when (outcome_index = 0 and held_0_before < held_1_before)
                or (outcome_index = 1 and held_1_before < held_0_before) then 'underweight'
            else 'overweight'
        end as inventory_side
    from running
)

select
    phase,
    count(*) as fills,
    round(100.0 * count(*) filter (where role = 'maker') / count(*), 2) as maker_fill_pct,
    sum(shares) as shares,
    sum(usdc) as usdc,
    round(sum(usdc) / nullif(sum(shares), 0), 6) as avg_price,
    count(distinct condition_id) as markets,
    count(*) filter (where inventory_side = 'underweight') as underweight_buys,
    count(*) filter (where inventory_side = 'overweight') as overweight_buys,
    count(*) filter (where inventory_side = 'balanced') as balanced_buys,
    round(
        100.0 * count(*) filter (where inventory_side = 'underweight')
        / nullif(count(*) filter (where inventory_side in ('underweight', 'overweight')), 0), 2
    ) as underweight_buy_pct
from classified
group by rollup (phase)
order by phase nulls last
