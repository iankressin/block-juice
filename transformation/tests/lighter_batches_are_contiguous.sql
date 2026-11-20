-- Lists each batch whose block count differs from its range, and each pair of loaded consecutive batches
-- whose ranges do not meet. A batch holds a contiguous block range and consecutive batches meet
-- (catalog/vendors/lighter/NOTES.md, L12); a join on block_number between first_block and last_block
-- relies on both. A batch with no blocks is listed too, since no block can join to it.
with ordered as (
    select
        batch_number,
        first_block,
        last_block,
        block_count,
        lag(batch_number) over (order by batch_number) as previous_batch_number,
        lag(last_block) over (order by batch_number) as previous_last_block
    from {{ ref('lighter_batches') }}
)

select batch_number, 'block_count is not last_block - first_block + 1' as problem
from ordered
where block_count is distinct from last_block - first_block + 1

union all

select batch_number, 'first_block is not the previous batch''s last_block + 1' as problem
from ordered
where previous_batch_number = batch_number - 1
    and first_block is distinct from previous_last_block + 1
