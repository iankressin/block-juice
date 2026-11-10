-- One top-level transaction sent from or to a wallet in chains/ethereum/addresses.json of
-- evm-wallet-transactions, with its receipt's fields, as Portal returned them. Amounts in wei, addresses
-- lowercased. status is 1 for success and 0 for a revert. to is null for a contract creation.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    data ->> 'block_hash' as block_hash,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    (data ->> 'transaction_index')::integer as transaction_index,
    lower(data ->> 'hash') as tx_hash,
    (data ->> 'nonce')::bigint as nonce,
    lower(data ->> 'from') as from_address,
    lower(data ->> 'to') as to_address,
    (data ->> 'value')::numeric as value,
    (data ->> 'type')::integer as tx_type,
    (data ->> 'status')::integer as status,
    (data ->> 'gas_used')::numeric as gas_used,
    (data ->> 'gas_price')::numeric as gas_price,
    (data ->> 'effective_gas_price')::numeric as effective_gas_price,
    (data ->> 'blob_gas_used')::numeric as blob_gas_used,
    (data ->> 'blob_gas_price')::numeric as blob_gas_price,
    lower(data ->> 'contract_address') as contract_address,
    data ->> 'sighash' as sighash,
    _loaded_at
from {{ source('ethereum', 'wallet_transactions') }}
