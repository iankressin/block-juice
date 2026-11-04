-- Every ERC-20 transfer into or out of a tracked Ethereum wallet, in the token's base units.
select
    id,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    token,
    from_address,
    to_address,
    value
from {{ ref('stg_ethereum__erc20_transfers') }}
