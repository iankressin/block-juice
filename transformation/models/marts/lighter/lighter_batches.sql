-- One Lighter L1 batch: the block range it holds, its tx count, status, and the hash and time of each
-- L1 step. Join an L2 block to its batch on block_number between first_block and last_block. Commit,
-- verify and execute columns are null until that step happens, and stay null on batches before 29654.
select
    batch_number,
    first_block,
    last_block,
    block_count,
    tx_count,
    first_block_time,
    last_block_time,
    status,
    is_final,
    commit_tx_hash,
    committed_at,
    verify_tx_hash,
    verified_at,
    execute_tx_hash,
    executed_at,
    final_at,
    updated_at
from {{ ref('int_lighter_batches') }}
