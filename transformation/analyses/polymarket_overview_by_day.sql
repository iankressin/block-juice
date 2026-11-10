-- Per UTC day: fills, volume and fees from polymarket_trades, and the markets that resolved that day.
with fills as (
    select
        date_trunc('day', block_timestamp) as day,
        count(*) as fills,
        sum(usdc) as volume_usdc,
        sum(fee_usdc) as fees_usdc,
        count(distinct condition_id) as markets_traded,
        count(distinct maker) as makers
    from {{ ref('polymarket_trades') }}
    group by 1
),

resolutions as (
    select date_trunc('day', resolved_at) as day, count(*) as markets_resolved
    from {{ ref('polymarket_markets') }}
    where resolved_at is not null
    group by 1
)

select f.*, coalesce(r.markets_resolved, 0) as markets_resolved
from fills as f
left join resolutions as r on r.day = f.day
order by f.day
