{#- The transfer_share panel from var('transfer_share'): one row per chain with its token and declared decimals. -#}
{% macro transfer_share_panel() -%}
    select chain, token, decimals
    from (values
    {%- for row in var('transfer_share')['panel'] %}
        ('{{ row.chain }}'::text, '{{ row.token }}'::text, {{ row.decimals }}::integer){{ ',' if not loop.last }}
    {%- endfor %}
    ) as panel (chain, token, decimals)
{%- endmacro %}


{#- The stages after S2, in order, each with the token_movements flag its mask reads. A movement is removed at
    the first stage whose mask it meets; each mask on its own also applies to S2 for the standalone columns.
    token_movements and transfer_share_stage_status both read this list, so the order lives in one place. -#}
{% macro transfer_share_stage_masks() %}
    {% do return([
        {'stage_number': 3, 'mask': 'is_self'},
        {'stage_number': 4, 'mask': 'same_entity'},
        {'stage_number': 5, 'mask': 'treasury_touch'},
    ]) %}
{% endmacro %}


{#- Tether token logs as movements, the one rule both Tether chains share (decision 7, rule_version 1).
    `logs` names a relation of a chain's successful Transfer, Issue, Redeem and DestroyedBlackFunds logs with
    id, event, tx_hash, from_address, to_address and value_base. An Issue or Redeem pairs with the Transfer of
    its transaction that moves the same amount from the zero address (Issue) or to it (Redeem). With exactly
    one such pair, the Transfer is the movement, as issuance or destruction, and the supply event is no row.
    With none, the supply event is the movement with no address on the minted or burned side. With more than
    one candidate either way, every log of the tie has a null family and null changes_supply. A Transfer from
    or to the zero address that pairs with nothing changes supply as `unpaired_zero_transfer_changes_supply`
    says, which is the chain's own proof. DestroyedBlackFunds is always a destruction. -#}
{% macro transfer_share_tether_movements(logs, zero_address, unpaired_zero_transfer_changes_supply) %}
with events (event, family) as (
    values
        ('Transfer', 'transfer'),
        ('Issue', 'issuance'),
        ('Redeem', 'destruction'),
        ('DestroyedBlackFunds', 'destruction')
),

candidates as (
    select
        supply.id as supply_id,
        transfer.id as transfer_id,
        events.family
    from {{ logs }} as supply
    inner join events on events.event = supply.event
    inner join {{ logs }} as transfer
        on transfer.event = 'Transfer'
        and transfer.tx_hash = supply.tx_hash
        and transfer.value_base = supply.value_base
        and case supply.event
            when 'Issue' then transfer.from_address
            when 'Redeem' then transfer.to_address
        end = {{ zero_address }}
    where supply.event in ('Issue', 'Redeem')
),

pairs as (
    select
        supply_id,
        transfer_id,
        family,
        count(*) over (partition by supply_id) = 1
            and count(*) over (partition by transfer_id) = 1 as is_unique
    from candidates
),

roles as (
    select supply_id as id, 'supply' as side, family, bool_and(is_unique) as is_unique
    from pairs
    group by supply_id, family
    union all
    select transfer_id as id, 'transfer' as side, min(family) as family, bool_and(is_unique) as is_unique
    from pairs
    group by transfer_id
)

select
    logs.*,
    case
        when roles.id is null then events.family
        when roles.is_unique then roles.family
    end as family,
    case
        when roles.id is not null then case when roles.is_unique then true end
        when logs.event <> 'Transfer' then true
        when {{ zero_address }} in (logs.from_address, logs.to_address) then {{ unpaired_zero_transfer_changes_supply }}
        else false
    end as changes_supply
from {{ logs }} as logs
inner join events on events.event = logs.event
left join roles on roles.id = logs.id
where not coalesce(roles.side = 'supply' and roles.is_unique, false)
{% endmacro %}


{#- One row per UTC midnight from a chain's first to its last recorded boundary, gaps included. B is Portal's
    first block (or slot) at or after the midnight. A midnight passes only when every check below holds, and
    reason names each check that failed. previous_block is the chain's rule for the block before B, an
    expression over `recorded` (the boundary record) and `portal_boundary` (Portal's header of B). -#}
{% macro transfer_share_day_boundaries(chain, boundaries, headers, previous_block) %}
with recorded as (
    select
        (midnight at time zone 'UTC')::date as day_utc,
        midnight,
        boundary_block
    from {{ boundaries }}
),

spine as (
    select
        day::date as day_utc,
        day at time zone 'UTC' as midnight
    from generate_series(
        (select min(day_utc) from recorded)::timestamp,
        (select max(day_utc) from recorded)::timestamp,
        interval '1 day'
    ) as day
)

select
    '{{ chain }}'::text as chain,
    spine.midnight,
    spine.day_utc,
    recorded.boundary_block,
    previous.previous_block,
    case when verdict.reason is null then 'pass' else 'fail' end as status,
    verdict.reason
from spine
left join recorded on recorded.day_utc = spine.day_utc
left join {{ headers }} as portal_boundary
    on portal_boundary.origin = 'portal' and portal_boundary.block_number = recorded.boundary_block
left join {{ headers }} as rpc_boundary
    on rpc_boundary.origin = 'rpc' and rpc_boundary.block_number = recorded.boundary_block
cross join lateral (select ({{ previous_block }})::bigint as previous_block) as previous
left join {{ headers }} as portal_previous
    on portal_previous.origin = 'portal' and portal_previous.block_number = previous.previous_block
left join {{ headers }} as rpc_previous
    on rpc_previous.origin = 'rpc' and rpc_previous.block_number = previous.previous_block
cross join lateral (
    select string_agg(check_name, ', ' order by position) filter (where not coalesce(passed, false)) as reason
    from (values
        (1, 'boundary_recorded', recorded.boundary_block is not null and recorded.midnight = spine.midnight),
        (2, 'portal_headers_present',
            portal_boundary.block_hash is not null and portal_boundary.block_timestamp is not null
            and portal_previous.block_hash is not null and portal_previous.block_timestamp is not null),
        (3, 'rpc_headers_present',
            rpc_boundary.block_hash is not null and rpc_boundary.block_timestamp is not null
            and rpc_boundary.parent_hash is not null and rpc_boundary.parent_number is not null
            and rpc_previous.block_hash is not null and rpc_previous.block_timestamp is not null),
        (4, 'origins_agree',
            portal_boundary.block_hash = rpc_boundary.block_hash
            and portal_boundary.block_timestamp = rpc_boundary.block_timestamp
            and portal_previous.block_hash = rpc_previous.block_hash
            and portal_previous.block_timestamp = rpc_previous.block_timestamp),
        (5, 'previous_is_parent',
            rpc_boundary.parent_number = previous.previous_block
            and rpc_boundary.parent_hash = rpc_previous.block_hash),
        (6, 'brackets_midnight',
            rpc_previous.block_timestamp < spine.midnight and spine.midnight <= rpc_boundary.block_timestamp)
    ) as checks (position, check_name, passed)
) as verdict
{% endmacro %}
