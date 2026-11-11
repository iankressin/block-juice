{{ config(tags=['reference']) }}
-- #41: per FBI-attributed Binance hack address active on ethereum blocks 26316189 to 26323364 (2026-11-01
-- UTC), its top-level ETH sent (value, fees, both) and received, and its balance, nonce and code at block
-- 26323364 (code also at 26294680), verified against Dune query 9103455 and block-pinned RPC reads. The
-- actual CTE is analyses/binance_hack_fbi_eth_2026_11_01_by_address.sql, its active rows, in long form.
with flows as (
    {{ attributed_eth_flows('binance-hack-2026-10-29', 'ethereum', 26316189, 26323364, 26294680) }}
),

actual as (
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
)
{{ reference_mismatches(ref('reference_binance_hack_fbi_eth_2026_11_01'), 'actual', ['address', 'metric'], 'amount', 'absolute', 0) }}
