-- RN1's cash flow per UTC hour on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00 to 2026-11-10 00:00
-- UTC): what it paid for shares, what merges and redemptions paid back, and the running balance. Amounts
-- are pUSD.
-- buy_cost_usdc is usdc + fee_usdc of its buys (sells would count as cash in; it has none).
-- net_cash_usdc runs from 0 at the window's first block, in (block, log index) order: negative means RN1 has
-- paid in more than it got back so far. cash_low_usdc is the lowest it reached in the hour and
-- cash_end_usdc where the hour ended. Positions from before the window are not in the starting 0: their
-- redemptions come in as cash with no cost, so the early days understate the cash tied up.
with flows as (
    select
        block_number,
        log_index,
        block_timestamp,
        case when side = 'buy' then -(usdc + fee_usdc) else usdc - fee_usdc end as cash,
        case when side = 'buy' then usdc + fee_usdc else 0 end as buy_cost,
        0::numeric as merged,
        0::numeric as redeemed
    from {{ ref('polymarket_wallet_fills') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and block_number between 91743315 and 97042228
    union all
    select
        block_number,
        log_index,
        block_timestamp,
        usdc,
        0,
        case when kind = 'merge' then usdc else 0 end,
        case when kind = 'redeem' then usdc else 0 end
    from {{ ref('polymarket_position_changes') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and block_number between 91743315 and 97042228
),

running as (
    select
        *,
        sum(cash) over (order by block_number, log_index rows unbounded preceding) as net_cash
    from flows
)

select
    date_trunc('hour', block_timestamp at time zone 'UTC') as hour,
    sum(buy_cost) as buy_cost_usdc,
    sum(merged) as merge_usdc,
    sum(redeemed) as redeem_usdc,
    min(net_cash) as cash_low_usdc,
    (array_agg(net_cash order by block_number desc, log_index desc))[1] as cash_end_usdc
from running
group by 1
order by 1
