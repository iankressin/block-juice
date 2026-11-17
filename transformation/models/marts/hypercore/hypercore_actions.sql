-- One HyperCore action, for the users the hypercore-actions source follows: an order, a cancel, a modify,
-- a transfer or any other signed L1 action. action holds the payload as the user signed it, and its keys
-- depend on action_type; orders name assets by number, not by coin. An ok status can still hold
-- per-item errors in response, which is a JSON string rather than an object on some rejected actions.
-- It rebuilds whole, not incrementally: the raw tables offer no change feed an incremental build could
-- trust (docs/fact-model-performance.md).
select
    id,
    block_number,
    block_timestamp,
    action_index,
    user_address,
    vault_address,
    action_type,
    action,
    status,
    response,
    nonce
from {{ ref('stg_hypercore__actions') }}
