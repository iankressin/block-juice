-- One row is one successful movement of a token on a panel chain, counted once: an Ethereum or TRON log
-- (Transfer, Issue, Redeem, DestroyedBlackFunds) or a Solana token instruction (transfer, mint, burn).
-- value_base is in the token's base units, never summed across chains, and value_tokens in whole tokens.
-- day_utc comes from height between two proved midnights, never from the row's own timestamp, and is null
-- when the block is not between two proved boundaries or has no timestamp. Labels apply by owner, which on
-- Ethereum and TRON is the address. in_s1 and in_s2 say whether S1 and S2 count the movement, and S3 to S5
-- each drop the transfers removed_at_stage names, at the first mask they meet.
{%- set columns -%}
    id, chain, token, block_number, block_hash, block_timestamp, tx_hash, tx_index, position, event, family,
    changes_supply, from_address, to_address, from_owner, to_owner, owner_status, value_base, decimals,
    value_tokens, account_self, owner_self
{%- endset %}
{%- set min_confidence = var('transfer_share')['label_min_confidence'] %}

with movements as (
    select {{ columns }} from {{ ref('int_ethereum_tether_token_movements') }}
    union all
    select {{ columns }} from {{ ref('int_tron_tether_token_movements') }}
    union all
    select {{ columns }} from {{ ref('int_solana_spl_token_movements') }}
),

-- The label rows that can apply at all. With no confidence threshold set, none can.
labels as (
    select chain, address, entity, role, evidence_date, effective_from, effective_to, label_version
    from {{ ref('entity_labels') }}
    where {% if min_confidence is none %}false{% else %}confidence >= {{ min_confidence }}{% endif %}
        and url is not null
        and evidence_date is not null
        and effective_from is not null
),

placed as (
    select
        movements.*,
        days.day_utc as boundary_day,
        case
            when days.opening_status = 'pass'
                and days.closing_status = 'pass'
                and movements.block_timestamp is not null
                then days.day_utc
        end as day_utc
    from movements
    left join {{ ref('int_transfer_share_days') }} as days
        on days.chain = movements.chain
        and movements.block_number >= days.from_block
        and movements.block_number < days.to_block
),

labeled as (
    select
        placed.*,
        from_label.entity as from_entity,
        from_label.role as from_role,
        to_label.entity as to_entity,
        to_label.role as to_role
    from placed
    -- One label a side, the latest version in force, so overlapping versions cannot copy a movement.
    left join lateral (
        select labels.entity, labels.role
        from labels
        where labels.chain = placed.chain
            and labels.address = placed.from_owner
            and labels.evidence_date <= placed.day_utc
            and labels.effective_from <= placed.block_timestamp
            and placed.block_timestamp < coalesce(labels.effective_to, 'infinity')
        order by labels.label_version desc
        limit 1
    ) as from_label on true
    left join lateral (
        select labels.entity, labels.role
        from labels
        where labels.chain = placed.chain
            and labels.address = placed.to_owner
            and labels.evidence_date <= placed.day_utc
            and labels.effective_from <= placed.block_timestamp
            and placed.block_timestamp < coalesce(labels.effective_to, 'infinity')
        order by labels.label_version desc
        limit 1
    ) as to_label on true
),

flagged as (
    select
        labeled.*,
        labeled.family is not null as in_s1,
        coalesce(labeled.family = 'transfer', false) as in_s2,
        -- On Ethereum and TRON the owner is the address, so owner-self is address-self there.
        labeled.owner_self as is_self,
        coalesce(labeled.from_entity = labeled.to_entity, false) as same_entity,
        coalesce(labeled.from_role = 'issuer_treasury' or labeled.to_role = 'issuer_treasury', false) as treasury_touch
    from labeled
)

select
    chain || ':' || id as id,
    chain,
    token,
    block_number,
    block_hash,
    block_timestamp,
    tx_hash,
    tx_index,
    position,
    event,
    family,
    changes_supply,
    from_address,
    to_address,
    from_owner,
    to_owner,
    owner_status,
    value_base,
    decimals,
    value_tokens,
    account_self,
    owner_self,
    boundary_day,
    day_utc,
    from_entity,
    to_entity,
    from_role,
    to_role,
    in_s1,
    in_s2,
    is_self,
    same_entity,
    treasury_touch,
    case when in_s2 then
        case
        {%- for mask in transfer_share_stage_masks() %}
            when {{ mask.mask }} then {{ mask.stage_number }}
        {%- endfor %}
        end
    end as removed_at_stage,
    {{ var('transfer_share')['rule_version'] }} as rule_version,
    '{{ invocation_id }}'::text as built_by_invocation
from flagged
