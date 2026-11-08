-- Fails where Solana's S2 volume is published without the unresolved-owner volume beside it. Unresolved
-- owners stay in every stage, and a reader needs to see how much of the volume they hold.
select day_utc, chain, stage, volume_tokens, unresolved_owner_tokens
from {{ ref('transfer_share_stage_status') }}
where chain = 'solana'
    and stage = 'S2'
    and volume_tokens is not null
    and unresolved_owner_tokens is null
