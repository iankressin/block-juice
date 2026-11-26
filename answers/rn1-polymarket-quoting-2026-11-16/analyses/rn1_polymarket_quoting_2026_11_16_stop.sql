-- When RN1 stops making a market: per resolved market with a Gamma game start time, the minutes from the start
-- to RN1's last maker fill, from that fill to resolution, and from the start to resolution, as percentiles over
-- markets; and the share of markets whose last maker fill was at 0.90 or more or 0.10 or less, a price that
-- says the result was nearly settled.
-- RN1 is the wallet 0x2005d16a84ceefa912d4e380cd32e7ff827875ea.
with maker as (
    select condition_id, block_timestamp, round(price, 3) as price
    from {{ ref('polymarket_wallet_fills') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and role = 'maker'
        and {{ in_window('block_number', 'polygon') }}
),

last_fill as (
    select distinct on (condition_id) condition_id, block_timestamp as last_at, price as last_price
    from maker
    order by condition_id, block_timestamp desc, price desc
),

timed as (
    select
        extract(epoch from (l.last_at - m.game_start_time)) / 60 as start_to_last,
        extract(epoch from (m.resolved_at - l.last_at)) / 60 as last_to_resolution,
        extract(epoch from (m.resolved_at - m.game_start_time)) / 60 as start_to_resolution,
        greatest(l.last_price, 1 - l.last_price) >= 0.9 as last_at_edge
    from last_fill as l
    inner join {{ ref('polymarket_markets') }} as m on m.condition_id = l.condition_id
    where m.resolved_at is not null and m.game_start_time is not null
)

select
    count(*) as markets,
    percentile_cont(0.1) within group (order by start_to_last) as start_to_last_p10_min,
    percentile_cont(0.5) within group (order by start_to_last) as start_to_last_p50_min,
    percentile_cont(0.9) within group (order by start_to_last) as start_to_last_p90_min,
    percentile_cont(0.1) within group (order by last_to_resolution) as last_to_resolution_p10_min,
    percentile_cont(0.5) within group (order by last_to_resolution) as last_to_resolution_p50_min,
    percentile_cont(0.9) within group (order by last_to_resolution) as last_to_resolution_p90_min,
    percentile_cont(0.5) within group (order by start_to_resolution) as start_to_resolution_p50_min,
    round(100.0 * avg(last_at_edge::int), 2) as last_fill_at_edge_pct
from timed
