-- Fails on any day and stage with a share row where a panel chain did not pass or has no share row of its
-- own. A share is only ever published for the whole panel.
with panel as (
    {{ transfer_share_panel() }}
),

published as (
    select distinct day_utc, stage
    from {{ ref('transfer_share') }}
)

select published.day_utc, published.stage, panel.chain, status.status, share.share
from published
cross join panel
left join {{ ref('transfer_share_stage_status') }} as status
    on status.day_utc = published.day_utc
    and status.stage = published.stage
    and status.chain = panel.chain
left join {{ ref('transfer_share') }} as share
    on share.day_utc = published.day_utc
    and share.stage = published.stage
    and share.chain = panel.chain
where status.status is distinct from 'pass'
    or share.chain is null
