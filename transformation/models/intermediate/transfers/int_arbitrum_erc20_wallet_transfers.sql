-- Arbitrum ERC-20 transfers into or out of the wallets evm-erc20-wallet-transfers follows, in the shape
-- erc20_wallet_flows reads, in the token's base units.
select
    'arbitrum' as chain,
    id,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    token,
    from_address,
    to_address,
    value
from {{ ref('stg_arbitrum__erc20_wallet_transfers') }}
