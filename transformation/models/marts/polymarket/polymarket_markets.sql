-- One row per Polymarket market: each condition of a Gamma v1 market, with Gamma's names, its payouts
-- once resolved, and whether the sources hold its whole history. payout_fractions are the pUSD one token
-- of each outcome redeems for, in outcome_index order.
-- The rows are the conditions of int_polymarket_outcome_tokens (progress R28), with Gamma's names from
-- int_polymarket_markets. prepared_block and history_complete come from
-- int_polygon_polymarket_ctf_conditions. A condition prepared before the window has no row there, so
-- prepared_block is null and it is not complete.
-- Keep both public projections in the scheduled graph even though this query shares their raw
-- projection locally. Existing direct selectors and consumers can continue to use their view names.
-- depends_on: {{ ref('int_polymarket_markets') }}
-- depends_on: {{ ref('int_polymarket_outcome_tokens') }}
-- Both naming and token eligibility need Gamma's rows. Parse the JSON once within this query;
-- keep it query-local so direct dbt selections still see corrections in the live staging view.
with gamma_rows as materialized (
    select
        condition_id, market_id, question, slug, event_id, event_title, neg_risk, outcomes,
        end_date, sports_market_type, fee_type, series_slug, game_start_time, clob_token_ids
    from {{ ref('stg_polymarket__markets') }}
    where protocol_version = 'v1'
),

token_markets as (
    select distinct on (condition_id) condition_id, clob_token_ids
    from gamma_rows
    where clob_token_ids is not null
    order by condition_id, length(market_id), market_id
),

markets as (
    -- Match int_polymarket_outcome_tokens' choice BEFORE expanding its tokens: an empty array
    -- on the winning row gives no market, while a null array is excluded before choosing it.
    select condition_id, 'ctf'::text as protocol
    from token_markets
    where cardinality(clob_token_ids) > 0
),

gamma as (
    select distinct on (condition_id)
        condition_id, market_id, question, slug, event_id, event_title, neg_risk, outcomes, end_date,
        sports_market_type is not null or coalesce(fee_type like 'sports%', false) as is_sports,
        sports_market_type, series_slug, game_start_time
    from gamma_rows
    where condition_id is not null
    order by condition_id, length(market_id), market_id
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
    g.market_id,
    g.question,
    g.slug,
    g.event_id,
    g.event_title,
    g.neg_risk,
    m.protocol,
    g.outcomes,
    g.end_date,
    c.prepared_block,
    r.resolved_at,
    r.payout_fractions,
    coalesce(c.history_complete, false) as history_complete,
    g.is_sports,
    g.sports_market_type,
    g.series_slug,
    g.game_start_time
from markets as m
left join gamma as g on g.condition_id = m.condition_id
left join conditions as c on c.condition_id = m.condition_id
left join resolutions as r on r.condition_id = m.condition_id
