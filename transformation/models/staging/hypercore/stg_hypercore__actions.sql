-- One HyperCore action as the hypercore-actions source loaded it: one signed action, such as an order, a
-- cancel or a leverage change, sent by a user in its addresses.json. action is the payload as the user
-- signed it, and its keys depend on action_type. vault_address is the vault the user acted for, null when
-- it acted for itself. status is ok or err. response is a JSON object for most actions but a JSON string
-- for some rejected ones. Field meanings are in catalog/protocols/hypercore/NOTES.md.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    (data -> 'action' ->> 'actionIndex')::integer as action_index,
    lower(data -> 'action' ->> 'user') as user_address,
    lower(data -> 'action' ->> 'vaultAddress') as vault_address,
    data -> 'action' -> 'action' ->> 'type' as action_type,
    data -> 'action' -> 'action' as action,
    data -> 'action' ->> 'status' as status,
    data -> 'action' -> 'response' as response,
    (data -> 'action' ->> 'nonce')::bigint as nonce,
    _loaded_at
from {{ source('hypercore', 'actions') }}
