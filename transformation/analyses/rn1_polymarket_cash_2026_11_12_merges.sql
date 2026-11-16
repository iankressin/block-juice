-- Each transaction in the answer's window that paid RN1 for merges: how many payouts, the pUSD they paid,
-- and RN1's pUSD balance just before the first and just after the last. Whole pUSD.
with flows as (
    select *
    from {{ ref('polymarket_wallet_cash_flows') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
        and symbol = 'pUSD'
        and kind = 'merge'
)

select
    tx_hash,
    min(block_timestamp) as block_timestamp,
    count(*) as payouts,
    sum(usdc_delta) as usdc,
    (array_agg(balance - usdc_delta order by block_number, log_index))[1] as pusd_before,
    (array_agg(balance order by block_number desc, log_index desc))[1] as pusd_after
from flows
group by tx_hash
order by block_timestamp
