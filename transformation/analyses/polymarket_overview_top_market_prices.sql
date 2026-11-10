-- Hourly price of each outcome of the 6 markets with the most volume: the close of the hour's last candle.
-- outcome_order is the outcome's place in Gamma's outcomes, from 1.
with top_markets as (
    select condition_id, sum(usdc) as volume_usdc
    from {{ ref('polymarket_trades') }}
    group by condition_id
    order by volume_usdc desc
    limit 6
),

hours as (
    select
        c.condition_id,
        c.outcome,
        date_trunc('hour', c.minute) as hour,
        (array_agg(c.close order by c.minute desc))[1] as close,
        sum(c.usdc_volume) as volume_usdc
    from {{ ref('polymarket_price_candles') }} as c
    inner join top_markets as t on t.condition_id = c.condition_id
    group by 1, 2, 3
)

select
    h.condition_id,
    m.question,
    t.volume_usdc as market_volume_usdc,
    h.outcome,
    array_position(m.outcomes, h.outcome) as outcome_order,
    h.hour,
    h.close,
    h.volume_usdc
from hours as h
inner join top_markets as t on t.condition_id = h.condition_id
inner join {{ ref('polymarket_markets') }} as m on m.condition_id = h.condition_id
order by t.volume_usdc desc, h.outcome, h.hour
