-- Lists each resolved Polymarket market whose wallets' PnL and fees do not add up to 0. A market's cash
-- moves only between its wallets, the fee receiver and ConditionalTokens, and once resolved its tokens
-- are worth the collateral ConditionalTokens holds for them, so sum(pnl_usdc) + sum(fees_usdc) is 0, up to
-- 0.000001 of rounding per row. A failure means the ledger misses a channel.
-- Neg-risk conversions move value between the markets of one event, so a neg-risk event adds up only as
-- a whole: the test sums it per event, over events whose markets have all resolved with complete history
-- and whose feeBips is 0, since a conversion's fee is not in fees_usdc. An event with no MarketPrepared in
-- the window counts as feeBips 0, as int_polygon_polymarket_ctf_position_changes does.
-- It warns rather than fails: two channels are not loaded, by design (progress R27). Users who call the
-- old binary adapter directly split, merge and redeem with no event that names them (R9), and outcome
-- tokens sent from wallet to wallet come in as free shares (plan Decision 5).
{{ config(severity='warn') }}
with markets as (
    select condition_id, event_id, neg_risk, resolved_at, history_complete
    from {{ ref('polymarket_markets') }}
),

participants as (
    select condition_id, pnl_usdc, fees_usdc
    from {{ ref('polymarket_market_participants') }}
),

binary_markets as (
    select
        'market' as scope,
        m.condition_id as id,
        sum(p.pnl_usdc) + sum(p.fees_usdc) as imbalance_usdc,
        count(*) as rows_summed
    from markets as m
    inner join participants as p on p.condition_id = m.condition_id
    where not m.neg_risk
        and m.resolved_at is not null
        and m.history_complete
    group by m.condition_id
),

event_fees as (
    select g.event_id, coalesce(max(prepared.fee_bips), 0) as fee_bips
    from {{ ref('stg_polymarket__markets') }} as g
    left join {{ ref('stg_polygon__polymarket_ctf') }} as prepared
        on prepared.event = 'neg_risk.MarketPrepared'
        and prepared.neg_risk_market_id = g.neg_risk_market_id
    where g.neg_risk
    group by g.event_id
),

closed_events as (
    select event_id
    from markets
    where neg_risk
    group by event_id
    having bool_and(resolved_at is not null and history_complete)
),

neg_risk_events as (
    select
        'neg_risk_event' as scope,
        m.event_id as id,
        sum(p.pnl_usdc) + sum(p.fees_usdc) as imbalance_usdc,
        count(*) as rows_summed
    from markets as m
    inner join closed_events as e on e.event_id = m.event_id
    inner join event_fees as f on f.event_id = m.event_id
    inner join participants as p on p.condition_id = m.condition_id
    where f.fee_bips = 0
    group by m.event_id
)

select scope, id, imbalance_usdc, rows_summed
from (
    select * from binary_markets
    union all
    select * from neg_risk_events
) as sums
where abs(imbalance_usdc) > 0.000001 * rows_summed
