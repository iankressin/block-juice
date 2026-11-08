-- One row per day of the question's window, stage and panel chain on which the whole panel passed, for
-- charts: the chain's volume, the panel's, the share, and beside them the labeled and unresolved-owner
-- volume. A day with no rows is a day the panel did not pass; a chart shows it as a gap, not a zero.
-- Volumes are in whole tokens.
{%- set window = var('transfer_share')['window'] %}
select
    shares.day_utc,
    shares.stage,
    shares.chain,
    shares.volume_tokens,
    shares.panel_volume_tokens,
    shares.share,
    daily.labeled_tokens,
    daily.unresolved_owner_tokens,
    shares.rule_version
from {{ ref('transfer_share') }} as shares
inner join {{ ref('transfer_share_stage_daily') }} as daily
    on daily.day_utc = shares.day_utc
    and daily.stage = shares.stage
    and daily.chain = shares.chain
where shares.day_utc >= '{{ window.from }}'::date
    and shares.day_utc < '{{ window.to }}'::date
order by shares.day_utc, shares.stage, shares.chain
