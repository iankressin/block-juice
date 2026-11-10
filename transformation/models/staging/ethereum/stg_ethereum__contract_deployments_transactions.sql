-- One transaction that has at least one create or create2 trace, as Portal returned it. Its traces are
-- in stg_ethereum__contract_deployments and its state diffs in stg_ethereum__contract_deployments_state_diffs,
-- joined on block_number and transaction_index. to_address is null for a top-level contract creation.
-- status is 1 for a successful transaction. transaction_type 4 is an EIP-7702 transaction.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    (data ->> 'transactionIndex')::integer as transaction_index,
    lower(data ->> 'hash') as hash,
    lower(data ->> 'from') as from_address,
    lower(data ->> 'to') as to_address,
    lower(data ->> 'sighash') as sighash,
    (data ->> 'type')::integer as transaction_type,
    (data ->> 'status')::integer as status,
    (data ->> 'gasUsed')::numeric as gas_used,
    _loaded_at
from {{ source('ethereum', 'contract_deployments') }}
where data ->> 'kind' = 'transaction'
