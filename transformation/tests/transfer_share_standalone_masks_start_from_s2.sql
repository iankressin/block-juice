-- Fails where standalone_removed_tokens is not its stage's mask applied to S2 alone. The masks are spelled
-- out here, apart from the stage list the mart uses, so a mask taken from the previous stage shows.
with panel as (
    {{ transfer_share_panel() }}
),

recomputed as (
    select
        movements.chain,
        movements.day_utc,
        coalesce(sum(movements.value_tokens) filter (where movements.in_s2 and movements.is_self), 0) as s3,
        coalesce(sum(movements.value_tokens) filter (where movements.in_s2 and movements.same_entity), 0) as s4,
        coalesce(sum(movements.value_tokens) filter (where movements.in_s2 and movements.treasury_touch), 0) as s5
    from {{ ref('token_movements') }} as movements
    inner join panel
        on panel.chain = movements.chain
        and panel.token = movements.token
    where movements.day_utc is not null
    group by movements.chain, movements.day_utc
)

select daily.day_utc, daily.chain, daily.stage, daily.standalone_removed_tokens, expected.tokens
from {{ ref('transfer_share_stage_daily') }} as daily
left join recomputed
    on recomputed.chain = daily.chain
    and recomputed.day_utc = daily.day_utc
cross join lateral (
    select case daily.stage
        when 'S3' then coalesce(recomputed.s3, 0)
        when 'S4' then coalesce(recomputed.s4, 0)
        when 'S5' then coalesce(recomputed.s5, 0)
    end as tokens
) as expected
where daily.stage in ('S3', 'S4', 'S5')
    and daily.standalone_removed_tokens is distinct from expected.tokens
