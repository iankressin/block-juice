-- One TRON transaction that a log of the Tether token source came from, as Portal returned it. The logs are
-- in stg_tron__tether_token, and their tx_hash is this hash. contract_ret is ret[0].contractRet, and owner
-- is the Base58 caller, kept byte for byte.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'tx_index')::integer as tx_index,
    data ->> 'hash' as hash,
    data ->> 'type' as type,
    data ->> 'result' as result,
    data ->> 'contract_ret' as contract_ret,
    data ->> 'owner' as owner,
    _loaded_at
from {{ source('tron', 'tether_token') }}
where data ->> 'kind' = 'transaction'
