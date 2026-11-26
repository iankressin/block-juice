-- Fills by the price they traded at, in 20 buckets of 0.05 pUSD per share. A price of exactly 1 counts in
-- the last bucket.
select
    (bucket - 1) * 0.05 as price_from,
    bucket * 0.05 as price_to,
    count(*) as fills,
    sum(shares) as shares,
    sum(usdc) as volume_usdc
from (
    select least(width_bucket(price, 0, 1, 20), 20) as bucket, shares, usdc
    from {{ ref('polymarket_trades') }}
) as fills
group by bucket
order by bucket
