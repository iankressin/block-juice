-- Each address that paid RN1 pUSD outside its trades in the answer's window: how often, on how many UTC
-- days, how much, and the size and hour of its payments. Whole pUSD.
with flows as (
    select *
    from {{ ref('polymarket_wallet_cash_flows') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
        and symbol = 'pUSD'
        and kind = 'transfer'
        and usdc_delta > 0
)

select
    counterparty as payer,
    count(*) as payments,
    count(distinct (block_timestamp at time zone 'UTC')::date) as days,
    sum(usdc_delta) as usdc,
    min(usdc_delta) as smallest_usdc,
    percentile_cont(0.5) within group (order by usdc_delta) as median_usdc,
    max(usdc_delta) as largest_usdc,
    min(block_timestamp) as first_at,
    max(block_timestamp) as last_at,
    percentile_cont(0.5) within group (
        order by extract(epoch from (block_timestamp at time zone 'UTC')::time) / 3600
    ) as median_utc_hour
from flows
group by counterparty
order by usdc desc
