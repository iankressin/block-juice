{{ config(tags=['reference']) }}
-- #49: each top-level ETH outflow from the wallet Lookonchain links to the Ethereum Foundation, with its
-- class and value in ETH, verified on ethereum blocks 26380784 to 26387956 (2026-11-10 UTC) against Dune
-- query 9109965 and block-pinned RPC reads. The actual CTE is
-- analyses/ef_linked_wallet_eth_outflows_2026_11_10_by_outflow.sql restricted to those blocks.
with actual as (
    select tx_hash, outflow_class, eth
    from {{ ref('wallet_eth_outflows') }}
    where chain = 'ethereum'
        and from_address = '0x5cbc6299fab3320e7758ac97fd4ca45e5b722059'
        and block_number between 26380784 and 26387956
)
{{ reference_mismatches(ref('reference_ef_linked_wallet_eth_outflows_2026_11_10'), 'actual', ['tx_hash', 'outflow_class'], 'eth', 'absolute', 0) }}
