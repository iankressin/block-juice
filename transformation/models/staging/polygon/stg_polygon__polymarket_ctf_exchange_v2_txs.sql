-- One transaction of the polygon-polymarket-ctf-exchange-v2 source: a transaction that an OrderFilled the
-- source loaded came from. function_name is matchOrders when the input decoded against the catalog ABI, with
-- the call's arguments in args, the signed orders among them (catalog/protocols/polymarket/NOTES.md, Q12).
-- Otherwise it is null and input holds the call as sent.
-- Named _txs, not _transactions: a dbt unit test names its fixture __dbt__cte__<model>, and the long name
-- passes Postgres' 63-character limit.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    lower(data ->> 'hash') as tx_hash,
    lower(data ->> 'from') as tx_from,
    lower(data ->> 'to') as tx_to,
    data ->> 'function' as function_name,
    lower(data -> 'args' ->> 'conditionId') as condition_id,
    data -> 'args' as args,
    data ->> 'input' as input,
    _loaded_at
from {{ source('polygon', 'polymarket_ctf_exchange_v2') }}
where data ->> 'kind' = 'transaction'
