-- One row per Polymarket market: each condition of a Gamma v1 market, with Gamma's names, its payouts
-- once resolved, and whether the sources hold its whole history. payout_fractions are the pUSD one token
-- of each outcome redeems for, in outcome_index order.
-- prepared_block and history_complete come from int_polygon_polymarket_ctf_conditions. A condition
-- prepared before the window has no row there, so prepared_block is null and it is not complete.
with markets as (
    select distinct condition_id, market_id, event_id, neg_risk, protocol
    from {{ ref('int_polymarket_outcome_tokens') }}
),

gamma as (
    select market_id, question, slug, event_title, outcomes, end_date
    from {{ ref('stg_polymarket__markets') }}
),

conditions as (
    select condition_id, prepared_block, history_complete
    from {{ ref('int_polygon_polymarket_ctf_conditions') }}
),

resolutions as (
    select
        condition_id,
        max(resolved_at) as resolved_at,
        array_agg(payout_fraction order by outcome_index) as payout_fractions
    from {{ ref('int_polygon_polymarket_ctf_resolutions') }}
    group by condition_id
)

select
    m.condition_id,
    m.market_id,
    g.question,
    g.slug,
    m.event_id,
    g.event_title,
    m.neg_risk,
    m.protocol,
    g.outcomes,
    g.end_date,
    c.prepared_block,
    r.resolved_at,
    r.payout_fractions,
    coalesce(c.history_complete, false) as history_complete
from markets as m
left join gamma as g on g.market_id = m.market_id
left join conditions as c on c.condition_id = m.condition_id
left join resolutions as r on r.condition_id = m.condition_id
