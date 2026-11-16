-- The pUSD paid to RN1 outside its trades, per UTC day and payer, with what RN1 did the day before: the
-- taker fees it paid and the pUSD it bought as maker and as taker, from its fills. A payer that pays a
-- rebate shows a steady ratio to one of them. The day before the window's first day has no fills loaded,
-- so its three columns are null. Whole pUSD.
with flows as (
    select *
    from {{ ref('polymarket_wallet_cash_flows') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
        and symbol = 'pUSD'
        and kind = 'transfer'
        and usdc_delta > 0
),

fills as (
    select
        (block_timestamp at time zone 'UTC')::date as day,
        sum(fee_usdc) as fee_usdc,
        sum(usdc) filter (where role = 'maker') as maker_usdc,
        sum(usdc) filter (where role = 'taker') as taker_usdc
    from {{ ref('polymarket_wallet_fills') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
    group by (block_timestamp at time zone 'UTC')::date
),

payments as (
    select
        (block_timestamp at time zone 'UTC')::date as day,
        counterparty as payer,
        count(*) as payments,
        sum(usdc_delta) as usdc,
        min(block_timestamp) as first_at
    from flows
    group by (block_timestamp at time zone 'UTC')::date, counterparty
)

select
    p.day,
    p.payer,
    p.payments,
    p.usdc,
    p.first_at,
    f.fee_usdc as fee_usdc_day_before,
    f.maker_usdc as maker_usdc_day_before,
    f.taker_usdc as taker_usdc_day_before
from payments as p
left join fills as f on f.day = p.day - 1
order by p.day, p.usdc desc
