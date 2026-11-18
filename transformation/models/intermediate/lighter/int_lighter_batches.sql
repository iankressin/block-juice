-- One Lighter L1 batch: its block range and tx count, its L1 hashes, and when each L1 step happened.
-- A batch holds a contiguous block range and consecutive batches meet (catalog/vendors/lighter/NOTES.md,
-- L12), so first_block and last_block are the lowest and highest block it lists, and the first and
-- last block times are theirs. Each L1 time is when the status change carrying that hash happened.
-- So verified_at is the change whose hash is verify_tx_hash: a nothing_to_execute change carries the
-- verify hash, with no verified change before it. status is the latest change's, the later one in
-- the list winning a tie of times, as verified and executed tie on 270062; with no change it is
-- pending. A batch is final once a change is executed or nothing_to_execute, and final_at is the
-- first such change. Batches before 29654 have no batch_details and no changes, so they stay pending
-- and never settle (L11).
with batches as (
    select * from {{ ref('stg_lighter__batches') }}
)

select
    batches.batch_number,
    blocks.first_block,
    blocks.last_block,
    blocks.block_count,
    blocks.tx_count,
    blocks.first_block_time,
    blocks.last_block_time,
    coalesce(l1.status, 'pending') as status,
    coalesce(l1.is_final, false) as is_final,
    batches.commit_tx_hash,
    l1.committed_at,
    batches.verify_tx_hash,
    l1.verified_at,
    batches.execute_tx_hash,
    l1.executed_at,
    l1.final_at,
    batches.updated_at
from batches
cross join lateral (
    select
        min(block_number) as first_block,
        max(block_number) as last_block,
        count(*) as block_count,
        sum(tx_count)::bigint as tx_count,
        (array_agg(block_time order by block_number))[1] as first_block_time,
        (array_agg(block_time order by block_number desc))[1] as last_block_time
    from (
        select
            (block ->> 'block_number')::bigint as block_number,
            (block ->> 'updated_at')::timestamptz as block_time,
            (block ->> 'total_transactions')::bigint as tx_count
        from jsonb_array_elements(batches.blocks) as block
    ) as listed
) as blocks
cross join lateral (
    select
        min(changed_at) filter (where hash = batches.commit_tx_hash) as committed_at,
        min(changed_at) filter (where hash = batches.verify_tx_hash) as verified_at,
        min(changed_at) filter (where hash = batches.execute_tx_hash) as executed_at,
        min(changed_at) filter (where batch_status in ('executed', 'nothing_to_execute')) as final_at,
        bool_or(batch_status in ('executed', 'nothing_to_execute')) as is_final,
        (array_agg(batch_status order by changed_at desc, position desc))[1] as status
    from (
        select
            change ->> 'hash' as hash,
            (change ->> 'updated_at')::timestamptz as changed_at,
            change ->> 'batch_status' as batch_status,
            position
        from jsonb_array_elements(batches.status_changes) with ordinality as changes (change, position)
    ) as listed
) as l1
