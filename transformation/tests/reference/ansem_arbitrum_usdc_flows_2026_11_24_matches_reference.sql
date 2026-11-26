{{ config(tags=['reference']) }}
-- #96: every native USDC Transfer log into or out of the six listed Arbitrum wallets, with its direction and
-- raw value, verified on arbitrum blocks 527033527 to 527106194 (2026-11-24 06:00:00 to 11:39:06 UTC)
-- against Dune query 9193713. The actual CTE is analyses/ansem_arbitrum_usdc_flows_2026_11_24_by_flow.sql
-- restricted to those blocks.
with actual as (
    select
        f.wallet,
        f.direction,
        f.tx_hash as transaction_hash,
        f.log_index,
        f.value
    from {{ ref('erc20_wallet_flows') }} as f
    where f.chain = 'arbitrum'
        and f.token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
        and f.wallet in (
            '0xac33748aad09cea8e50484cc0fa168dc23531b4d',
            '0x06ee679b907a654a9126caf511922f632f6e4b03',
            '0x0a0a6bd1c26becc4b3d94d2a695c3484d9e26072',
            '0xb8009d1da10b8fe53330cfb2cbc77f2de241f3ec',
            '0x7c612de1ed39e75400f2b659c668084761e05e20',
            '0x48411900612f3fad92b133d0bfa95225085f753e'
        )
        and f.block_number between 527033527 and 527106194
)
{{ reference_mismatches(ref('reference_ansem_arbitrum_usdc_flows_2026_11_24'), 'actual', ['wallet', 'direction', 'transaction_hash', 'log_index'], 'value', 'absolute', 0) }}
