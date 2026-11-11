{{ config(tags=['reference']) }}
-- #48: daily ETH, USDT and USDC inflow, outflow, net and intra-set flows of the 23 DefiLlama-labelled MEXC
-- wallets, for every counterparty and for the Binance PoR addresses, verified on ethereum blocks 26359254 to
-- 26366423 (2026-11-07 UTC) against Dune query 9109979 (execution 01M75DKQASX0PE7K7FEG9MVH09). The actual
-- CTE is analyses/mexc_labelled_flows_2026_11_by_day.sql restricted to those blocks.
with actual as (
    {{ labelled_flows_daily(
        'MEXC',
        'ethereum',
        [['eth', 'native'], ['usdt', '0xdac17f958d2ee523a2206206994597c13d831ec7'], ['usdc', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']],
        ['Binance'],
        26359254,
        26366423
    ) }}
)
{{ reference_mismatches(ref('reference_mexc_labelled_flows_2026_11'), 'actual', ['day', 'token', 'counterparty', 'metric'], 'amount', 'absolute', 0) }}
