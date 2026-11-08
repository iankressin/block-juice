-- One row per chain and UTC day whose opening and closing midnights both have a row in that chain's day
-- boundaries. The day holds the blocks from_block <= block < to_block, and is proved when both midnights
-- pass. A day with no row here has no boundary data on that chain.
with midnights as (
    select chain, day_utc, boundary_block, status from {{ ref('int_ethereum_day_boundaries') }}
    union all
    select chain, day_utc, boundary_block, status from {{ ref('int_tron_day_boundaries') }}
    union all
    select chain, day_utc, boundary_block, status from {{ ref('int_solana_day_boundaries') }}
)

select
    opening.chain,
    opening.day_utc,
    opening.boundary_block as from_block,
    closing.boundary_block as to_block,
    opening.status as opening_status,
    closing.status as closing_status
from midnights as opening
inner join midnights as closing
    on closing.chain = opening.chain
    and closing.day_utc = opening.day_utc + 1
