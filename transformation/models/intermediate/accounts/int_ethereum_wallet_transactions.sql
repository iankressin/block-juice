-- Ethereum's top-level wallet transactions in the shape wallet_transactions reads. The fee is what the
-- sender paid for execution gas, gas_used * effective_gas_price, in wei, charged whether the transaction
-- succeeded or reverted. A type-3 transaction also burns blob gas, kept apart in blob_fee_wei.
select
    'ethereum' as chain,
    block_number,
    block_timestamp,
    transaction_index,
    tx_hash,
    from_address,
    to_address,
    value as value_wei,
    status = 1 as succeeded,
    tx_type,
    gas_used,
    effective_gas_price,
    gas_used * effective_gas_price as fee_wei,
    coalesce(blob_gas_used * blob_gas_price, 0) as blob_fee_wei
from {{ ref('stg_ethereum__wallet_transactions') }}
