-- One row per UTC day, stage and panel chain, only when every panel chain passed that day and stage and the
-- panel's volume is not zero. share is the chain's volume over the panel's, both in whole tokens, so TRON's
-- share is the TRON row. A day and stage with no rows is one the panel did not pass. It is not a zero share,
-- and a two-chain share is never published.
with status as (
    select * from {{ ref('transfer_share_stage_status') }}
),

panel_days as (
    select
        day_utc,
        stage,
        sum(volume_tokens) as panel_volume_tokens
    from status
    group by day_utc, stage
    having bool_and(status = 'pass') and sum(volume_tokens) <> 0
)

select
    status.day_utc,
    status.stage,
    status.chain,
    status.volume_tokens,
    panel_days.panel_volume_tokens,
    trim_scale(status.volume_tokens / panel_days.panel_volume_tokens) as share,
    status.rule_version,
    '{{ invocation_id }}'::text as built_by_invocation
from status
inner join panel_days
    on panel_days.day_utc = status.day_utc
    and panel_days.stage = status.stage
