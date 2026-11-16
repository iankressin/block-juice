-- RN1's cash transfers in the answer's window by token, kind and direction: how many, in how many
-- transactions, and the tokens moved, positive when the wallet got them. Whole tokens.
with flows as (
    select *
    from {{ ref('polymarket_wallet_cash_flows') }}
    where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('block_number', 'polygon') }}
)

select
    symbol,
    kind,
    case when usdc_delta >= 0 then 'in' else 'out' end as direction,
    count(*) as transfers,
    count(distinct tx_hash) as transactions,
    count(distinct counterparty) as counterparties,
    sum(usdc_delta) as usdc,
    min(block_timestamp) as first_at,
    max(block_timestamp) as last_at
from flows
group by symbol, kind, case when usdc_delta >= 0 then 'in' else 'out' end
order by symbol, abs(sum(usdc_delta)) desc
