-- Fails on any TRON or Solana address in staging that is not the raw text byte for byte. Base58 is
-- case-sensitive, so a lower() in staging would name another address.
select 'stg_tron__tether_token' as model, staged.id
from {{ ref('stg_tron__tether_token') }} as staged
inner join {{ source('tron', 'tether_token') }} as raw on raw.id = staged.id
where staged.contract is distinct from raw.data ->> 'contract'
    or staged.from_address is distinct from raw.data -> 'args' ->> 'from'
    or staged.to_address is distinct from raw.data -> 'args' ->> 'to'
    or staged.blacklisted_user is distinct from raw.data -> 'args' ->> '_blackListedUser'
union all
select 'stg_tron__tether_token_transactions' as model, staged.id
from {{ ref('stg_tron__tether_token_transactions') }} as staged
inner join {{ source('tron', 'tether_token') }} as raw on raw.id = staged.id
where staged.owner is distinct from raw.data ->> 'owner'
union all
select 'stg_solana__spl_token' as model, staged.id
from {{ ref('stg_solana__spl_token') }} as staged
inner join {{ source('solana', 'spl_token') }} as raw on raw.id = staged.id
where staged.accounts is distinct from raw.data -> 'accounts'
    or staged.owner_arg is distinct from raw.data -> 'args' ->> 'owner'
    or staged.new_authority is distinct from raw.data -> 'args' ->> 'newAuthority'
union all
select 'stg_solana__spl_token_balances' as model, staged.id
from {{ ref('stg_solana__spl_token_balances') }} as staged
inner join {{ source('solana', 'spl_token') }} as raw on raw.id = staged.id
where staged.account is distinct from raw.data ->> 'account'
    or staged.pre_mint is distinct from raw.data ->> 'pre_mint'
    or staged.post_mint is distinct from raw.data ->> 'post_mint'
    or staged.pre_owner is distinct from raw.data ->> 'pre_owner'
    or staged.post_owner is distinct from raw.data ->> 'post_owner'
