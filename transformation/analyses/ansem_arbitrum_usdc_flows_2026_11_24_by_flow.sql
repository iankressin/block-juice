-- Every native USDC Transfer log over the answer's window into or out of the six listed Arbitrum wallets
-- (ticket #96), seen from each listed wallet: `in` or `out`, the other side as counterparty, value in base
-- units and in USDC. A transfer between two listed wallets is a row for each. Addresses match in full.
select
    f.wallet,
    f.direction,
    f.tx_hash as transaction_hash,
    f.log_index,
    f.value,
    f.block_number,
    f.block_timestamp,
    f.counterparty,
    f.value / power(10, t.decimals) as usdc
from {{ ref('erc20_wallet_flows') }} as f
left join {{ ref('tokens') }} as t on t.chain = f.chain and t.token = f.token
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
    and {{ in_window('f.block_number', 'arbitrum') }}
order by f.block_number, f.log_index, f.wallet, f.direction
