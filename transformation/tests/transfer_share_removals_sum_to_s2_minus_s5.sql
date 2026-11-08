-- Fails on any day and chain where what S3, S4 and S5 drop does not add up to S2 minus S5. removed_at_stage
-- holds one stage per transfer, so the drops split S2 minus S5 with nothing counted twice.
select
    day_utc,
    chain,
    sum(volume_tokens) filter (where stage = 'S2') - sum(volume_tokens) filter (where stage = 'S5') as s2_minus_s5,
    sum(removed_tokens) as removed_tokens
from {{ ref('transfer_share_stage_daily') }}
group by day_utc, chain
having sum(volume_tokens) filter (where stage = 'S2') - sum(volume_tokens) filter (where stage = 'S5')
    is distinct from sum(removed_tokens)
