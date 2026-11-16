-- The pUSD paid to RN1 in the answer's window outside its trades: every pUSD transfer into the wallet in a
-- transaction with no fill, merge or redemption of RN1's, in whole pUSD.
with flows as (
    select *
    from {{ ref('polymarket_wallet_cash_flows') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
)

select sum(usdc_delta) as payments_usdc
from flows
where symbol = 'pUSD'
    and kind = 'transfer'
    and usdc_delta > 0
