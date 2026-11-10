-- One row per top-level transaction sent from or to a wallet a wallet-transactions source follows, on
-- every chain it covers. Amounts in wei. value_wei moved only when succeeded is true; fee_wei
-- (gas_used * effective_gas_price) and blob_fee_wei are paid by from_address either way. Internal
-- transfers, which only traces show, are not here. Each chain's intermediate model brings its rows in
-- this shape, so a new chain adds one branch.
select
    chain,
    block_number,
    block_timestamp,
    transaction_index,
    tx_hash,
    from_address,
    to_address,
    value_wei,
    succeeded,
    tx_type,
    gas_used,
    effective_gas_price,
    fee_wei,
    blob_fee_wei
from {{ ref('int_ethereum_wallet_transactions') }}
