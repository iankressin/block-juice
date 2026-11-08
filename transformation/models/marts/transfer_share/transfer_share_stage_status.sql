-- One row per UTC day, panel chain and stage (S1 to S5), for every day from the first to the last proved
-- midnight of any panel chain. status is pass, fail or unknown, where unknown means the chain has no
-- boundary data for the day, and reasons names each check that did not pass. Measures are in whole tokens of
-- the chain's panel token, and are null unless status is pass. unassigned_tokens and the boundary blocks
-- always show.
-- Stages: S1 counts every movement and S2 the transfers. S3, S4 and S5 each drop from the stage before the
-- transfers whose first mask is theirs (self, same entity, issuer treasury), and removed_tokens is what each
-- drops. standalone_removed_tokens applies each of those masks to S2 alone.
{%- set masks = transfer_share_stage_masks() %}
with panel as (
    {{ transfer_share_panel() }}
),

stages (stage, stage_number) as (
    values ('S1', 1), ('S2', 2), ('S3', 3), ('S4', 4), ('S5', 5)
),

days as (
    select days.*
    from {{ ref('int_transfer_share_days') }} as days
    inner join panel on panel.chain = days.chain
),

proved_midnights as (
    select day_utc from days where opening_status = 'pass'
    union
    select day_utc + 1 from days where closing_status = 'pass'
),

spine as (
    select day::date as day_utc
    from generate_series(
        (select min(day_utc) from proved_midnights)::timestamp,
        (select max(day_utc) - 1 from proved_midnights)::timestamp,
        interval '1 day'
    ) as day
),

-- A movement whose mint could not be named stays in, so the classification check can see it.
movements as (
    select movements.*
    from {{ ref('token_movements') }} as movements
    inner join panel
        on panel.chain = movements.chain
        and (panel.token = movements.token or movements.token is null)
    where movements.boundary_day is not null
),

day_movements as (
    select
        chain,
        boundary_day as day_utc,
        count(*) filter (where block_timestamp is null) as untimed,
        count(*) filter (
            where token is null or family is null or changes_supply is null or value_base is null or decimals is null
        ) as unclassified
    from movements
    group by chain, boundary_day
),

checks as (
    select days.chain, days.day_utc, day_check.check_name, day_check.passed
    from days
    left join day_movements
        on day_movements.chain = days.chain
        and day_movements.day_utc = days.day_utc
    cross join lateral (values
        ('opening_boundary', days.opening_status = 'pass'),
        ('closing_boundary', days.closing_status = 'pass'),
        ('movements_have_time', coalesce(day_movements.untimed, 0) = 0),
        ('movements_classified', coalesce(day_movements.unclassified, 0) = 0)
    ) as day_check (check_name, passed)
    union all
    select chain, day_utc, check_name, passed from {{ ref('int_ethereum_tether_token_day_checks') }}
    union all
    select chain, day_utc, check_name, passed from {{ ref('int_tron_tether_token_day_checks') }}
    union all
    select chain, day_utc, check_name, passed from {{ ref('int_solana_spl_token_day_checks') }}
),

verdicts as (
    select
        chain,
        day_utc,
        string_agg(check_name, ', ' order by check_name) filter (where not coalesce(passed, false)) as reasons
    from checks
    group by chain, day_utc
),

measures as (
    select
        movements.chain,
        movements.boundary_day as day_utc,
        stages.stage,
        sum(movements.value_tokens) filter (where member.in_stage) as volume_tokens,
        count(*) filter (where member.in_stage) as movements,
        sum(movements.value_tokens) filter (where movements.removed_at_stage = stages.stage_number) as removed_tokens,
        sum(movements.value_tokens) filter (where member.in_mask) as standalone_removed_tokens,
        sum(movements.value_tokens) filter (where member.in_stage and movements.account_self) as account_self_tokens,
        sum(movements.value_tokens) filter (
            where member.in_stage and movements.owner_status = 'unresolved'
        ) as unresolved_owner_tokens,
        sum(movements.value_tokens) filter (
            where member.in_stage and (movements.from_entity is not null or movements.to_entity is not null)
        ) as labeled_tokens,
        sum(movements.value_tokens) filter (
            where member.in_stage and movements.block_timestamp is null
        ) as unassigned_tokens
    from movements
    cross join stages
    cross join lateral (
        select
            case stages.stage_number
                when 1 then movements.in_s1
                when 2 then movements.in_s2
                else movements.in_s2 and coalesce(movements.removed_at_stage > stages.stage_number, true)
            end as in_stage,
            movements.in_s2 and case stages.stage_number
            {%- for mask in masks %}
                when {{ mask.stage_number }} then movements.{{ mask.mask }}
            {%- endfor %}
                else false
            end as in_mask
    ) as member
    group by movements.chain, movements.boundary_day, stages.stage
),

graded as (
    select
        spine.day_utc,
        panel.chain,
        stages.stage,
        stages.stage_number,
        case
            when days.chain is null then 'unknown'
            when verdicts.reasons is null then 'pass'
            else 'fail'
        end as status,
        case when days.chain is null then 'no_boundary_data' else verdicts.reasons end as reasons,
        days.from_block,
        days.to_block,
        days.chain is not null as has_boundary_data
    from spine
    cross join panel
    cross join stages
    left join days
        on days.chain = panel.chain
        and days.day_utc = spine.day_utc
    left join verdicts
        on verdicts.chain = panel.chain
        and verdicts.day_utc = spine.day_utc
)

select
    graded.day_utc,
    graded.chain,
    graded.stage,
    graded.status,
    graded.reasons,
    case when graded.status = 'pass' then coalesce(measures.volume_tokens, 0) end as volume_tokens,
    case when graded.status = 'pass' then coalesce(measures.movements, 0) end as movements,
    case when graded.status = 'pass' and graded.stage_number >= 3 then coalesce(measures.removed_tokens, 0) end
        as removed_tokens,
    case when graded.status = 'pass' and graded.stage_number >= 3 then coalesce(measures.standalone_removed_tokens, 0) end
        as standalone_removed_tokens,
    case when graded.status = 'pass' then coalesce(measures.account_self_tokens, 0) end as account_self_tokens,
    case when graded.status = 'pass' then coalesce(measures.unresolved_owner_tokens, 0) end as unresolved_owner_tokens,
    case when graded.status = 'pass' then coalesce(measures.labeled_tokens, 0) end as labeled_tokens,
    case when graded.has_boundary_data then coalesce(measures.unassigned_tokens, 0) end as unassigned_tokens,
    graded.from_block as boundary_from_block,
    graded.to_block as boundary_to_block,
    {{ var('transfer_share')['rule_version'] }} as rule_version,
    '{{ invocation_id }}'::text as built_by_invocation
from graded
left join measures
    on measures.chain = graded.chain
    and measures.day_utc = graded.day_utc
    and measures.stage = graded.stage
