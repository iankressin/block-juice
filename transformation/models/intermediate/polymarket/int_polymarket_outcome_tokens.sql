-- One row per outcome token of a Gamma v1 market. Gamma's clobTokenIds[i] is the token of outcomes[i]
-- (catalog/vendors/polymarket/NOTES.md), and that order matches the index set 1 << i (catalog Q6), so
-- outcome_index is the position in clobTokenIds, counted from 0. A placeholder market has no tokens and
-- gives no rows. Protocol V2 markets (Task 13) are not here yet.
with markets as (
    select *
    from {{ ref('stg_polymarket__markets') }}
    where protocol_version = 'v1'
        and clob_token_ids is not null
)

select
    t.token_id,
    m.condition_id,
    (t.position - 1)::integer as outcome_index,
    m.outcomes[t.position] as outcome,
    case when cardinality(m.clob_token_ids) = 2 then m.clob_token_ids[3 - t.position] end as complement_token_id,
    m.market_id,
    m.event_id,
    m.neg_risk,
    'ctf' as protocol
from markets as m
cross join lateral unnest(m.clob_token_ids) with ordinality as t(token_id, position)
