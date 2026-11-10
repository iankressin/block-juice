-- The 25 wallets with the highest and the 25 with the lowest PnL, over markets whose whole history is in
-- the window and whose PnL is known.
with wallets as (
    select
        wallet,
        count(*) as markets,
        sum(trades) as trades,
        sum(buy_usdc + sell_usdc) as traded_usdc,
        sum(fees_usdc) as fees_usdc,
        sum(pnl_usdc) as pnl_usdc
    from {{ ref('polymarket_market_participants') }}
    where history_complete and pnl_usdc is not null
    group by wallet
),

ranked as (
    select
        *,
        row_number() over (order by pnl_usdc desc, wallet) as from_top,
        row_number() over (order by pnl_usdc, wallet) as from_bottom
    from wallets
)

select
    case when from_top <= 25 then 'highest' else 'lowest' end as list,
    case when from_top <= 25 then from_top else from_bottom end as rank,
    wallet,
    markets,
    trades,
    traded_usdc,
    fees_usdc,
    pnl_usdc
from ranked
where from_top <= 25 or from_bottom <= 25
order by list, rank
