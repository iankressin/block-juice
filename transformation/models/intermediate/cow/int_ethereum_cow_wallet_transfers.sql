-- One ERC-20 Transfer into a wallet evm-cow-ethflow follows on Ethereum, any token. Amount in the
-- token's base units.
select
    'ethereum' as chain,
    block_number,
    block_timestamp,
    transaction_index,
    tx_hash,
    log_index,
    contract as token,
    transfer_from as from_address,
    transfer_to as to_address,
    transfer_value as amount
from {{ ref('stg_ethereum__cow_ethflow') }}
where event = 'Transfer'
