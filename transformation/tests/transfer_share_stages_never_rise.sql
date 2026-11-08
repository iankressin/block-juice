-- Fails on any day and chain where a stage after S2 holds more volume than the stage before it. S3, S4 and
-- S5 each only drop transfers, so a rise means a movement came back.
with stages as (
    select
        day_utc,
        chain,
        stage,
        volume_tokens,
        lag(volume_tokens) over (partition by day_utc, chain order by stage) as previous_volume_tokens
    from {{ ref('transfer_share_stage_daily') }}
    where stage in ('S2', 'S3', 'S4', 'S5')
)

select day_utc, chain, stage, volume_tokens, previous_volume_tokens
from stages
where volume_tokens > previous_volume_tokens
