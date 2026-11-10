-- Fills by their size in pUSD, before fees, in powers of ten.
select
    bucket,
    min(lower_usdc) as lower_usdc,
    count(*) as fills,
    sum(usdc) as volume_usdc
from (
    select
        usdc,
        case
            when usdc < 1 then 1
            when usdc < 10 then 2
            when usdc < 100 then 3
            when usdc < 1000 then 4
            when usdc < 10000 then 5
            else 6
        end as bucket,
        case
            when usdc < 1 then 0
            when usdc < 10 then 1
            when usdc < 100 then 10
            when usdc < 1000 then 100
            when usdc < 10000 then 1000
            else 10000
        end as lower_usdc
    from {{ ref('polymarket_trades') }}
) as fills
group by bucket
order by bucket
