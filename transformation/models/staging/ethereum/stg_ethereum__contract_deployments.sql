-- One trace of a transaction that has at least one create or create2 trace, as Portal returned it: each
-- create trace, and the frames above it. trace_address is the frame's path from the transaction's top
-- frame, which is the empty array. error is null when the frame did not fail. The create_ columns are
-- set on create traces, the call_ columns on call traces. code is the deployed runtime code, as hex.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    (data ->> 'transaction_index')::integer as transaction_index,
    data ->> 'trace_type' as trace_type,
    array(select jsonb_array_elements_text(data -> 'trace_address')::integer) as trace_address,
    (data ->> 'subtraces')::integer as subtraces,
    data ->> 'error' as error,
    -- create
    lower(case when data ->> 'trace_type' = 'create' then data -> 'action' ->> 'from' end) as create_from,
    (case when data ->> 'trace_type' = 'create' then data -> 'action' ->> 'value' end)::numeric as create_value,
    lower(data -> 'result' ->> 'address') as create_address,
    lower(data -> 'result' ->> 'code') as create_code,
    -- call
    lower(case when data ->> 'trace_type' = 'call' then data -> 'action' ->> 'from' end) as call_from,
    lower(data -> 'action' ->> 'to') as call_to,
    data -> 'action' ->> 'callType' as call_type,
    lower(data -> 'action' ->> 'sighash') as call_sighash,
    _loaded_at
from {{ source('ethereum', 'contract_deployments') }}
where data ->> 'kind' = 'trace'
