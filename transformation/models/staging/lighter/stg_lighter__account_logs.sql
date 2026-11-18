-- One ledger entry in one account's log, as the lighter-account-logs source loaded it from the Explorer.
-- An entry in two listed accounts' logs, such as a transfer between them, has a row under each.
-- pubdata is the entry's one <kind>_pubdata object: decimal strings, account indexes as integer strings
-- and assets as symbols. status is the entry's batch status, null until batched. Meanings are in
-- catalog/vendors/lighter/NOTES.md, Account logs.
select
    id,
    (data ->> 'account_index')::bigint as account_index,
    data -> 'entry' ->> 'hash' as hash,
    data -> 'entry' ->> 'tx_type' as tx_type,
    data -> 'entry' ->> 'pubdata_type' as pubdata_type,
    (data -> 'entry' ->> 'time')::timestamptz as log_time,
    data -> 'entry' ->> 'status' as status,
    jsonb_path_query_first(data -> 'entry' -> 'pubdata', '$.*') as pubdata,
    _loaded_at
from {{ source('lighter', 'account_logs') }}
where id like 'log:%'
