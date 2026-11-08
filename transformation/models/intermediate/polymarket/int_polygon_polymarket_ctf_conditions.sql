-- One row per condition ConditionalTokens prepared in the window, from its ConditionPreparation log
-- (catalog proof row 19), and whether the sources hold its whole history.
-- history_complete holds when the condition was prepared at or after the coverage start, the greatest of
-- the two Polygon Polymarket raw tables' lowest blocks (progress R28, R33). A condition prepared before
-- the window has no row here. Until both raw tables hold rows, the coverage start is unknown and no
-- condition is complete.
with preparations as (
    select distinct on (condition_id)
        condition_id,
        block_number as prepared_block,
        block_timestamp as prepared_at
    from {{ ref('stg_polygon__polymarket_ctf') }}
    where event = 'ctf.ConditionPreparation'
    order by condition_id, block_number, log_index
),

starts as (
    select
        (select min(block_number) from {{ ref('stg_polygon__polymarket_ctf') }}) as ctf_start,
        (select min(block_number) from {{ ref('stg_polygon__polymarket_ctf_exchange_v2') }}) as exchange_start
),

-- greatest() skips nulls, so it alone would let an empty table count as covered.
coverage as (
    select case when ctf_start is not null and exchange_start is not null
        then greatest(ctf_start, exchange_start)
    end as start_block
    from starts
)

select
    p.condition_id,
    p.prepared_block,
    p.prepared_at,
    coalesce(p.prepared_block >= coverage.start_block, false) as history_complete
from preparations as p
cross join coverage
