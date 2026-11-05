-- Every move of the token between an L2 and Ethereum in its windows through each chain's own bridge,
-- oldest first: the L2 address and its kind, the Ethereum address on the other side, and, when the move
-- pairs with one into or out of another L2 through Ethereum (bridge_pairs), that move's chain, L2 address
-- and time. Bridge moves name the token by its Ethereum address, var('token').ethereum.
with moves as (
    select b.*, l.kind as l2_kind
    from ({{ token_bridge_transfers() }}) as b
    left join {{ ref('address_labels') }} as l on l.chain = b.chain and l.address = b.l2_address
),

pairs as (
    select * from {{ ref('bridge_pairs') }}
    where ethereum_token = '{{ var('token').ethereum | lower }}'
)

select
    m.chain,
    m.direction,
    m.l2_address,
    m.l2_kind,
    m.ethereum_address,
    round(m.amount / {{ token_unit() }}, 6) as amount,
    m.block_timestamp,
    m.tx_hash,
    coalesce(sent.to_chain, received.from_chain) as other_chain,
    coalesce(sent.to_address, received.from_address) as other_l2_address,
    coalesce(sent.deposited_at, received.withdrawn_at) as other_at
from moves as m
left join pairs as sent on sent.withdrawal_id = m.id and sent.from_chain = m.chain
left join pairs as received on received.deposit_id = m.id and received.to_chain = m.chain
order by m.block_timestamp, m.chain, m.id
