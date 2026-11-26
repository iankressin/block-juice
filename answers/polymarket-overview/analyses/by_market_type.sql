-- Traded markets split by neg-risk or binary, and resolved in the window or still open.
with volume as (
    select condition_id, count(*) as fills, sum(usdc) as volume_usdc
    from {{ ref('polymarket_trades') }}
    group by condition_id
)

select
    case when m.neg_risk then 'neg-risk' else 'binary' end as market_type,
    case when m.resolved_at is not null then 'resolved' else 'open' end as status,
    count(*) as markets_traded,
    sum(v.fills) as fills,
    sum(v.volume_usdc) as volume_usdc
from volume as v
inner join {{ ref('polymarket_markets') }} as m on m.condition_id = v.condition_id
group by 1, 2
order by 1, 2
