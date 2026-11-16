-- RN1's pUSD balance over the answer's window, in whole pUSD: what it held before its first transfer and
-- after its last, the lowest and highest it reached and when, and its USDC.e balance at both ends.
with flows as (
    select *
    from {{ ref('polymarket_wallet_cash_flows') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
),

pusd as (
    select * from flows where symbol = 'pUSD'
),

usdc_e as (
    select * from flows where symbol = 'USDC.e'
)

select
    (select count(*) from pusd) as pusd_transfers,
    (select balance - usdc_delta from pusd order by block_number, log_index limit 1) as opening_pusd,
    (select balance from pusd order by block_number desc, log_index desc limit 1) as closing_pusd,
    (select min(balance) from pusd) as lowest_pusd,
    (select block_timestamp from pusd order by balance, block_number, log_index limit 1) as lowest_at,
    (select max(balance) from pusd) as highest_pusd,
    (select block_timestamp from pusd order by balance desc, block_number, log_index limit 1) as highest_at,
    (select count(*) from usdc_e) as usdc_e_transfers,
    (select balance - usdc_delta from usdc_e order by block_number, log_index limit 1) as opening_usdc_e,
    (select balance from usdc_e order by block_number desc, log_index desc limit 1) as closing_usdc_e,
    (select max(balance) from usdc_e) as highest_usdc_e
