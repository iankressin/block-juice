-- Wallets by their PnL in pUSD over markets whose whole history is in the window and whose PnL is known.
with wallets as (
    select wallet, sum(pnl_usdc) as pnl_usdc
    from {{ ref('polymarket_market_participants') }}
    where history_complete and pnl_usdc is not null
    group by wallet
),

bucketed as (
    select
        pnl_usdc,
        case
            when pnl_usdc <= -10000 then 1
            when pnl_usdc <= -1000 then 2
            when pnl_usdc <= -100 then 3
            when pnl_usdc < 0 then 4
            when pnl_usdc = 0 then 5
            when pnl_usdc < 100 then 6
            when pnl_usdc < 1000 then 7
            when pnl_usdc < 10000 then 8
            else 9
        end as bucket
    from wallets
)

select
    bucket,
    case bucket
        when 1 then '≤ -10k'
        when 2 then '-10k to -1k'
        when 3 then '-1k to -100'
        when 4 then '-100 to 0'
        when 5 then '0'
        when 6 then '0 to 100'
        when 7 then '100 to 1k'
        when 8 then '1k to 10k'
        else '≥ 10k'
    end as pnl_range_usdc,
    count(*) as wallets,
    sum(pnl_usdc) as pnl_usdc
from bucketed
group by bucket
order by bucket
