-- Each transaction in the answer's window in which RN1 unwrapped pUSD: the pUSD it gave up, the USDC.e it
-- got for it and sent on, where the USDC.e went, and its pUSD balance before and after. Whole tokens.
with flows as (
    select *
    from {{ ref('polymarket_wallet_cash_flows') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
),

unwraps as (
    select distinct tx_hash from flows where kind = 'unwrap'
)

select
    f.tx_hash,
    min(f.block_timestamp) as block_timestamp,
    -sum(f.usdc_delta) filter (where f.symbol = 'pUSD' and f.kind = 'unwrap') as pusd_unwrapped,
    sum(f.usdc_delta) filter (where f.symbol = 'USDC.e' and f.kind = 'unwrap') as usdc_e_received,
    -sum(f.usdc_delta) filter (where f.symbol = 'USDC.e' and f.kind = 'transfer' and f.usdc_delta < 0) as usdc_e_sent,
    min(f.counterparty) filter (where f.symbol = 'USDC.e' and f.kind = 'transfer' and f.usdc_delta < 0) as sent_to,
    count(distinct f.counterparty) filter (
        where f.symbol = 'USDC.e' and f.kind = 'transfer' and f.usdc_delta < 0
    ) as destinations,
    max(f.balance - f.usdc_delta) filter (where f.symbol = 'pUSD' and f.kind = 'unwrap') as pusd_before,
    min(f.balance) filter (where f.symbol = 'pUSD' and f.kind = 'unwrap') as pusd_after
from flows as f
inner join unwraps as u on u.tx_hash = f.tx_hash
group by f.tx_hash
order by block_timestamp
