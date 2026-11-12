-- One createOrder call from a followed wallet to an ETH Flow contract, from evm-cow-ethflow, as Portal
-- returned it. output is the call's return value, the GPv2 order hash, null when the call failed. Value in
-- wei, addresses lowercased.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    lower(data ->> 'tx_hash') as tx_hash,
    (data ->> 'transaction_index')::integer as transaction_index,
    data -> 'trace_address' as trace_address,
    data ->> 'error' as error,
    lower(data ->> 'from') as from_address,
    lower(data ->> 'to') as to_address,
    (data ->> 'value')::numeric as value,
    data ->> 'sighash' as sighash,
    data ->> 'input' as input,
    lower(data ->> 'output') as output,
    _loaded_at
from {{ source('ethereum', 'cow_ethflow') }}
where data ->> 'kind' = 'trace'
