-- One row per Polymarket market: each condition of a Gamma v1 market, with Gamma's names, its payouts
-- once resolved, and whether the sources hold its whole history. payout_fractions are the pUSD one token
-- of each outcome redeems for, in outcome_index order.
-- history_complete holds when ConditionalTokens prepared the condition at or after the coverage start,
-- the greatest of each Polygon Polymarket raw table's lowest block (progress R28). A condition prepared
-- before the window has no ConditionPreparation row, so prepared_block is null and it is not complete.
-- Until both raw tables hold rows, the coverage start is unknown and no market is complete.
with conditions as (
    select distinct condition_id, market_id, event_id, neg_risk, protocol
    from {{ ref('int_polymarket_outcome_tokens') }}
),

gamma as (
    select market_id, question, slug, event_title, outcomes, end_date
    from {{ ref('stg_polymarket__markets') }}
),

preparations as (
    select condition_id, min(block_number) as prepared_block
    from {{ ref('stg_polygon__polymarket_ctf') }}
    where event = 'ctf.ConditionPreparation'
    group by condition_id
),

resolutions as (
    select
        condition_id,
        max(resolved_at) as resolved_at,
        array_agg(payout_fraction order by outcome_index) as payout_fractions
    from {{ ref('int_polygon_polymarket_ctf_resolutions') }}
    group by condition_id
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
    c.condition_id,
    c.market_id,
    g.question,
    g.slug,
    c.event_id,
    g.event_title,
    c.neg_risk,
    c.protocol,
    g.outcomes,
    g.end_date,
    p.prepared_block,
    r.resolved_at,
    r.payout_fractions,
    coalesce(p.prepared_block >= coverage.start_block, false) as history_complete
from conditions as c
cross join coverage
left join gamma as g on g.market_id = c.market_id
left join preparations as p on p.condition_id = c.condition_id
left join resolutions as r on r.condition_id = c.condition_id
