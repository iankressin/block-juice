-- The 25 Gamma events with the most volume, over their markets.
with volume as (
    select condition_id, count(*) as fills, sum(usdc) as volume_usdc
    from {{ ref('polymarket_trades') }}
    group by condition_id
)

select
    m.event_id,
    max(m.event_title) as event_title,
    bool_or(m.neg_risk) as neg_risk,
    count(*) as markets_traded,
    count(*) filter (where m.resolved_at is not null) as markets_resolved,
    sum(v.fills) as fills,
    sum(v.volume_usdc) as volume_usdc
from volume as v
inner join {{ ref('polymarket_markets') }} as m on m.condition_id = v.condition_id
group by m.event_id
order by volume_usdc desc
limit 25
