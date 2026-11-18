-- One change to a listed Lighter account's holdings: a money move leg, a perp fill, an hour of funding or a
-- position exit. amount is signed in the asset's units, and null where the change has no proven amount:
-- stake, unstake, unlock, margin moves and exits. cumulative_amount is the running sum of amount per
-- account, asset and route, from the start of what is loaded. Rules are in int_lighter_account_ledger.
select
    id,
    account_index,
    event_time,
    kind,
    asset,
    route,
    amount,
    cumulative_amount,
    market_id,
    position_after,
    trade_id,
    hash,
    block_number,
    batch_number,
    batch_status,
    execute_tx_hash,
    executed_at
from {{ ref('int_lighter_account_ledger') }}
