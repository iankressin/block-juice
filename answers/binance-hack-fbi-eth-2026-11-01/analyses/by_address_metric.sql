-- The active rows of by_address in long form, one row per address and metric: the shape of reference.csv.
with flows as (
    {{ attributed_eth_flows('binance-hack-2026-10-29', 'ethereum', window_start('ethereum'), window_end('ethereum'), 26294680) }}
)

select flows.address, m.metric, m.amount
from flows
cross join lateral (
    values
        ('sent_value_wei', flows.sent_value_wei),
        ('sent_fees_wei', flows.sent_fees_wei),
        ('sent_out_wei', flows.sent_out_wei),
        ('received_wei', flows.received_wei),
        ('balance_wei', flows.balance_wei),
        ('nonce', flows.nonce::numeric),
        ('has_code', case when flows.has_code then 1 when not flows.has_code then 0 end::numeric)
) as m (metric, amount)
where flows.active
order by flows.address, m.metric
