-- Fails on any amount in the transfer_share raw tables whose text is not all digits. Staging leaves such an
-- amount null rather than cast it, and this names the record.
with amounts as (
    select 'ethereum.tether_token' as source, raw.id, amount.text
    from {{ source('ethereum', 'tether_token') }} as raw
    cross join lateral (values
        (raw.data -> 'args' ->> 'value'),
        (raw.data -> 'args' ->> 'amount'),
        (raw.data -> 'args' ->> '_balance'),
        (raw.data -> 'args' ->> 'feeBasisPoints'),
        (raw.data -> 'args' ->> 'maxFee')
    ) as amount (text)
    where raw.data ->> 'kind' = 'log'
    union all
    select 'tron.tether_token' as source, raw.id, amount.text
    from {{ source('tron', 'tether_token') }} as raw
    cross join lateral (values
        (raw.data -> 'args' ->> 'value'),
        (raw.data -> 'args' ->> 'amount'),
        (raw.data -> 'args' ->> '_balance'),
        (raw.data -> 'args' ->> 'feeBasisPoints'),
        (raw.data -> 'args' ->> 'maxFee')
    ) as amount (text)
    where raw.data ->> 'kind' = 'log'
    union all
    select 'solana.spl_token' as source, raw.id, amount.text
    from {{ source('solana', 'spl_token') }} as raw
    cross join lateral (values
        (raw.data -> 'args' ->> 'amount'),
        (raw.data ->> 'pre_amount'),
        (raw.data ->> 'post_amount')
    ) as amount (text)
    where raw.data ->> 'kind' in ('instruction', 'token_balance')
    union all
    select 'ethereum.erc20_supply' as source, raw.id, raw.data ->> 'total_supply' as text
    from {{ source('ethereum', 'erc20_supply') }} as raw
)

select source, id, text
from amounts
where text is not null
    and text !~ '^[0-9]+$'
