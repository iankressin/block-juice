-- Every SQD move between Arbitrum or Base and Ethereum in October 2026 through each chain's own bridge,
-- oldest first: the L2 address and its kind, the Ethereum address on the other side, and, when the move
-- pairs with one into or out of the other L2 through Ethereum (bridge_pairs), that move's chain, L2
-- address and time. SQD has one Ethereum token, 0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1.
with moves as (
    select b.*, l.kind as l2_kind
    from {{ ref('bridge_transfers') }} as b
    left join {{ ref('address_labels') }} as l on l.chain = b.chain and l.address = b.l2_address
    where b.ethereum_token = '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1'
        and (
            (b.chain = 'arbitrum' and b.block_number between 510496864 and 520129273)
            or (b.chain = 'base' and b.block_number between 52011727 and 53350926)
        )
),

pairs as (
    select * from {{ ref('bridge_pairs') }}
    where ethereum_token = '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1'
)

select
    m.chain,
    m.direction,
    m.l2_address,
    m.l2_kind,
    m.ethereum_address,
    round(m.amount / 1e18, 6) as sqd,
    m.block_timestamp,
    m.tx_hash,
    coalesce(sent.to_chain, received.from_chain) as other_chain,
    coalesce(sent.to_address, received.from_address) as other_l2_address,
    coalesce(sent.deposited_at, received.withdrawn_at) as other_at
from moves as m
left join pairs as sent on sent.withdrawal_id = m.id and sent.from_chain = m.chain
left join pairs as received on received.deposit_id = m.id and received.to_chain = m.chain
order by m.block_timestamp, m.chain, m.id
