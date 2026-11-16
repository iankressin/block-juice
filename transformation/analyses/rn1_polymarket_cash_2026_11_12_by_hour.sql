-- RN1's pUSD balance in each UTC hour of the answer's window that had a transfer: the lowest and highest
-- balance after any transfer in the hour, the balance after the hour's last transfer, and the hour's pUSD
-- by kind, positive when the wallet got it. Whole pUSD.
with flows as (
    select *
    from {{ ref('polymarket_wallet_cash_flows') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
        and symbol = 'pUSD'
)

select
    date_trunc('hour', block_timestamp, 'UTC') as hour,
    count(*) as transfers,
    min(balance) as balance_low,
    max(balance) as balance_high,
    (array_agg(balance order by block_number desc, log_index desc))[1] as balance_end,
    coalesce(sum(usdc_delta) filter (where kind = 'trade'), 0) as trade_usdc,
    coalesce(sum(usdc_delta) filter (where kind = 'redeem'), 0) as redeem_usdc,
    coalesce(sum(usdc_delta) filter (where kind = 'merge'), 0) as merge_usdc,
    coalesce(sum(usdc_delta) filter (where kind = 'transfer'), 0) as payment_usdc,
    coalesce(sum(usdc_delta) filter (where kind = 'unwrap'), 0) as unwrap_usdc
from flows
group by date_trunc('hour', block_timestamp, 'UTC')
order by hour
