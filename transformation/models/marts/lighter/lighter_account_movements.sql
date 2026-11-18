-- One leg of a deposit, withdrawal, transfer, route move, pool, staking or margin move in a listed
-- account's Lighter log, with the L1 batch whose block range holds it and that batch's Ethereum hashes
-- and times. Batch columns are null until the entry's block is in a loaded batch. Rules are in
-- int_lighter_account_movements.
select
    id,
    hash,
    log_time,
    account_index,
    leg,
    kind,
    asset,
    route,
    amount,
    signed_amount,
    counterparty_account_index,
    l1_address,
    pubdata_type,
    tx_type,
    block_number,
    batch_number,
    detail_batch_number,
    batch_status,
    is_final,
    commit_tx_hash,
    committed_at,
    verify_tx_hash,
    verified_at,
    execute_tx_hash,
    executed_at,
    final_at
from {{ ref('int_lighter_account_movements') }}
