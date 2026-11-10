-- The 50 markets with the most volume, with Gamma's names and each outcome's last candle close.
with volume as (
    select
        condition_id,
        count(*) as fills,
        sum(usdc) as volume_usdc,
        sum(fee_usdc) as fees_usdc,
        count(distinct maker) as makers,
        min(block_timestamp) as first_fill_at,
        max(block_timestamp) as last_fill_at
    from {{ ref('polymarket_trades') }}
    group by condition_id
    order by volume_usdc desc
    limit 50
),

last_closes as (
    select distinct on (c.condition_id, c.outcome) c.condition_id, c.outcome, c.close
    from {{ ref('polymarket_price_candles') }} as c
    inner join volume as v on v.condition_id = c.condition_id
    order by c.condition_id, c.outcome, c.minute desc
),

prices as (
    select condition_id, string_agg(outcome || ' ' || round(close, 3), ' / ' order by outcome desc) as last_prices
    from last_closes
    group by condition_id
)

select
    v.condition_id,
    m.question,
    m.event_title,
    m.slug,
    m.neg_risk,
    m.end_date,
    m.resolved_at,
    p.last_prices,
    v.fills,
    v.volume_usdc,
    v.fees_usdc,
    v.makers,
    v.first_fill_at,
    v.last_fill_at
from volume as v
inner join {{ ref('polymarket_markets') }} as m on m.condition_id = v.condition_id
left join prices as p on p.condition_id = v.condition_id
order by v.volume_usdc desc
