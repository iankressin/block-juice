-- Fails on any status row that did not pass yet carries a measure. A failed or unknown day must read as
-- missing, never as a number.
select day_utc, chain, stage, status
from {{ ref('transfer_share_stage_status') }}
where status <> 'pass'
    and (
        volume_tokens is not null
        or movements is not null
        or removed_tokens is not null
        or standalone_removed_tokens is not null
        or account_self_tokens is not null
        or unresolved_owner_tokens is not null
        or labeled_tokens is not null
    )
