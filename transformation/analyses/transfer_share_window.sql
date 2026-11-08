-- Each panel chain's share of the panel's volume, per stage, over the question's window: var('transfer_share')
-- window [from, to), in UTC days. The share is the chain's summed volume over the panel's summed volume, a
-- ratio of sums and never an average of daily shares. It is null when any day of the window has no
-- transfer_share row for that stage, since a sum over the days that passed is not the window. Label coverage
-- and unresolved-owner volume are over the same days. Volumes are in whole tokens.
{%- set window = var('transfer_share')['window'] %}
with window_days as (
    select day::date as day_utc
    from generate_series(
        '{{ window.from }}'::timestamp,
        '{{ window.to }}'::timestamp - interval '1 day',
        interval '1 day'
    ) as day
),

panel as (
    {{ transfer_share_panel() }}
),

stages (stage) as (
    values ('S1'), ('S2'), ('S3'), ('S4'), ('S5')
),

shares as (
    select shares.*
    from {{ ref('transfer_share') }} as shares
    inner join window_days on window_days.day_utc = shares.day_utc
),

sums as (
    select
        shares.stage,
        shares.chain,
        count(*) as days,
        sum(shares.volume_tokens) as volume_tokens,
        sum(shares.panel_volume_tokens) as panel_volume_tokens,
        sum(daily.labeled_tokens) as labeled_tokens,
        sum(daily.unresolved_owner_tokens) as unresolved_owner_tokens
    from shares
    inner join {{ ref('transfer_share_stage_daily') }} as daily
        on daily.day_utc = shares.day_utc
        and daily.stage = shares.stage
        and daily.chain = shares.chain
    group by shares.stage, shares.chain
)

select
    stages.stage,
    panel.chain,
    (select count(*) from window_days) as window_days,
    coalesce(sums.days, 0) as days_with_share,
    sums.volume_tokens,
    sums.panel_volume_tokens,
    case
        when coalesce(sums.days, 0) = (select count(*) from window_days)
            then trim_scale(sums.volume_tokens / nullif(sums.panel_volume_tokens, 0))
    end as share,
    trim_scale(sums.labeled_tokens / nullif(sums.volume_tokens, 0)) as label_coverage,
    sums.unresolved_owner_tokens
from stages
cross join panel
left join sums
    on sums.stage = stages.stage
    and sums.chain = panel.chain
order by stages.stage, panel.chain
