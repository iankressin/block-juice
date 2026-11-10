-- Per UTC hour: fills and volume from polymarket_trades.
select
    date_trunc('hour', block_timestamp) as hour,
    count(*) as fills,
    sum(usdc) as volume_usdc,
    sum(fee_usdc) as fees_usdc
from {{ ref('polymarket_trades') }}
group by 1
order by 1
