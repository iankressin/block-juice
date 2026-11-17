-- How RN1 turns shares back into pUSD on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00 to 2026-11-10
-- 00:00 UTC): one row per kind of exit and the contract event behind it, with its count, its pUSD and its
-- timing. RN1 sold nothing on the exchange in the window, so these are its only exits.
-- usdc is what RN1 got. A merge pays 1 pUSD per pair; a redemption pays the market's payout.
-- made_by reads the event: auto_redeemer.* events are Polymarket's auto-redeemer acting for the wallet; any
-- other event is the wallet's own call.
-- Minutes are measured from Gamma's game_start_time and from the market's resolved_at; events of a market
-- that lacks one are left out of that measure. events_before_resolution counts exits of a market that had
-- not resolved yet, or never did.
with exits as (
    select
        c.*,
        m.game_start_time,
        m.resolved_at,
        extract(epoch from c.block_timestamp - m.game_start_time) / 60 as minutes_from_start,
        extract(epoch from c.block_timestamp - m.resolved_at) / 60 as minutes_from_resolution
    from {{ ref('polymarket_position_changes') }} as c
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = c.condition_id
    where c.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and c.block_number between 91743315 and 97042228
)

select
    kind,
    event,
    case when event like 'auto_redeemer.%' then 'polymarket auto-redeemer' else 'the wallet' end as made_by,
    count(*) as events,
    count(distinct tx_hash) as transactions,
    count(distinct condition_id) as markets,
    count(distinct (block_timestamp at time zone 'UTC')::date) as days,
    sum(usdc) as usdc,
    round(avg(usdc), 6) as avg_usdc,
    count(*) filter (where resolved_at is null or block_timestamp < resolved_at) as events_before_resolution,
    round(percentile_cont(0.5) within group (order by minutes_from_start)::numeric, 1) as median_minutes_from_start,
    round(percentile_cont(0.5) within group (order by minutes_from_resolution)::numeric, 1)
        as median_minutes_from_resolution,
    round(percentile_cont(0.9) within group (order by minutes_from_resolution)::numeric, 1)
        as p90_minutes_from_resolution
from exits
group by kind, event
order by usdc desc
