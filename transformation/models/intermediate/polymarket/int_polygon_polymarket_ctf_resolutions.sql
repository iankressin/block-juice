-- The payout of each outcome of a condition that ConditionalTokens resolved. Neg-risk conditions resolve
-- through the same ConditionResolution event (catalog proof row 20). payout_numerators[i] is outcome i's
-- numerator; the fraction is that over the sum, so a [1, 0] vector pays 1 and 0. Postgres arrays start at 1.
with resolutions as (
    select *
    from {{ ref('stg_polygon__polymarket_ctf') }}
    where event = 'ctf.ConditionResolution'
)

select
    r.condition_id,
    (n.position - 1)::integer as outcome_index,
    n.numerator / nullif((select sum(s) from unnest(r.payout_numerators) as s), 0) as payout_fraction,
    r.block_number as resolved_block,
    r.block_timestamp as resolved_at
from resolutions as r
cross join lateral unnest(r.payout_numerators) with ordinality as n(numerator, position)
