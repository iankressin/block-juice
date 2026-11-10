-- One Gamma market per row, v1 and v2 alike. Field types are in catalog/vendors/polymarket/NOTES.md.
-- outcomes and clobTokenIds are strings that hold JSON; clobTokenIds[i] is the token of outcomes[i].
-- Token ids are uint256, so numeric. A placeholder neg-risk market has an empty conditionId and no
-- clobTokenIds: it keeps its row, with null condition_id and clob_token_ids.
-- events holds one element; the event fields come from it.
with markets as (
    select
        data,
        (data ->> 'outcomes')::jsonb as outcomes,
        (data ->> 'clobTokenIds')::jsonb as clob_token_ids,
        data -> 'events' -> 0 as event,
        _loaded_at
    from {{ source('polymarket', 'markets') }}
)

select
    data ->> 'id' as market_id,
    nullif(lower(data ->> 'conditionId'), '') as condition_id,
    nullif(lower(data ->> 'questionID'), '') as question_id,
    data ->> 'question' as question,
    data ->> 'slug' as slug,
    event ->> 'id' as event_id,
    event ->> 'slug' as event_slug,
    event ->> 'title' as event_title,
    (select array_agg(o.value order by o.position) from jsonb_array_elements_text(outcomes) with ordinality as o(value, position)) as outcomes,
    (select array_agg(t.value::numeric order by t.position) from jsonb_array_elements_text(clob_token_ids) with ordinality as t(value, position)) as clob_token_ids,
    coalesce((data ->> 'negRisk')::boolean, false) as neg_risk,
    nullif(lower(data ->> 'negRiskMarketID'), '') as neg_risk_market_id,
    data ->> 'version' as protocol_version,
    nullif(data ->> 'startDate', '')::timestamptz as start_date,
    nullif(data ->> 'endDate', '')::timestamptz as end_date,
    (data ->> 'closed')::boolean as closed,
    nullif(data ->> 'createdAt', '')::timestamptz as created_at,
    nullif(data ->> 'updatedAt', '')::timestamptz as updated_at,
    _loaded_at
from markets
