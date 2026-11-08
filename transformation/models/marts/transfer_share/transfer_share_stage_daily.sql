-- One row per UTC day, panel chain and stage that passed: the pass rows of transfer_share_stage_status, in
-- whole tokens of the chain's panel token. A day, chain and stage with no row did not pass. It is not a zero.
select
    day_utc,
    chain,
    stage,
    volume_tokens,
    movements,
    removed_tokens,
    standalone_removed_tokens,
    account_self_tokens,
    unresolved_owner_tokens,
    labeled_tokens,
    unassigned_tokens,
    boundary_from_block,
    boundary_to_block,
    rule_version,
    '{{ invocation_id }}'::text as built_by_invocation
from {{ ref('transfer_share_stage_status') }}
where status = 'pass'
