-- Fails on any movement carrying a label that no entity_labels row may apply to it: the row needs a url,
-- evidence dated on or before the movement's day, an effective interval that holds the block time, and a
-- confidence at or above the threshold. While the threshold is unset, no label may apply at all.
{%- set min_confidence = var('transfer_share')['label_min_confidence'] %}
with used as (
    select id, chain, from_owner as owner, from_entity as entity, from_role as role, day_utc, block_timestamp
    from {{ ref('token_movements') }}
    where from_entity is not null
    union all
    select id, chain, to_owner as owner, to_entity as entity, to_role as role, day_utc, block_timestamp
    from {{ ref('token_movements') }}
    where to_entity is not null
)

select used.*
from used
where not exists (
    select 1
    from {{ ref('entity_labels') }} as labels
    where labels.chain = used.chain
        and labels.address = used.owner
        and labels.entity = used.entity
        and labels.role = used.role
        and labels.url is not null
        and labels.evidence_date <= used.day_utc
        and labels.effective_from <= used.block_timestamp
        and used.block_timestamp < coalesce(labels.effective_to, 'infinity')
        and {% if min_confidence is none %}false{% else %}labels.confidence >= {{ min_confidence }}{% endif %}
)
