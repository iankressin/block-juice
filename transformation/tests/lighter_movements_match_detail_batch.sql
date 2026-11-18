-- Lists each movement whose batch from the block range differs from the batch logs/{hash} named, and each
-- movement with a block but no batch while a loaded batch ends at or after that block, so a loaded batch
-- should hold it. In L20 the batch the Explorer named held its entry's block every time
-- (catalog/vendors/lighter/NOTES.md). It warns, not fails: a batch that lighter-batches failed to read
-- waits as a dead letter, and its movements have no batch until a later run reads it. A detail read
-- before its batch formed names no batch and is not listed, nor is a block past the newest loaded batch.
{{ config(severity='warn') }}

with movements as (
    select * from {{ ref('lighter_account_movements') }}
)

select id, 'detail_batch_number is not batch_number' as problem
from movements
where detail_batch_number <> batch_number

union all

select id, 'no loaded batch holds block_number, though one ends at or after it' as problem
from movements
where block_number is not null
    and batch_number is null
    and exists (
        select 1
        from {{ ref('lighter_batches') }} as batches
        where batches.last_block >= movements.block_number
    )
