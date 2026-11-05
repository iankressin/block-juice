-- Every pair of EOAs that sent SQD from one to the other in October 2026, most SQD first: on the same
-- chain, Arbitrum or Base, and across them, when a withdrawal from one L2 started in October pairs with a
-- deposit into the other through Ethereum (bridge_pairs) and both L2 ends are EOAs. chain names the route
-- of a cross-chain pair, such as arbitrum>base. EIP-7702 delegated EOAs count as EOAs.
{%- set windows = [
    {'chain': 'arbitrum', 'token': '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1', 'blocks': [510496864, 520129273]},
    {'chain': 'base', 'token': '0xd4554bea546efa83c1e6b389ecac40ea999b3e78', 'blocks': [52011727, 53350926]},
] %}
with classified as (
    {{ classified_transfers(windows) }}
),

same_chain as (
    select chain, from_address, to_address, sum(value) as value, count(*) as transfers
    from classified
    where category = 'p2p'
    group by chain, from_address, to_address
),

cross_chain as (
    select
        p.from_chain || '>' || p.to_chain as chain,
        p.from_address,
        p.to_address,
        sum(p.amount) as value,
        count(*) as transfers
    from {{ ref('bridge_pairs') }} as p
    join {{ ref('address_labels') }} as f on f.chain = p.from_chain and f.address = p.from_address and f.kind = 'eoa'
    join {{ ref('address_labels') }} as t on t.chain = p.to_chain and t.address = p.to_address and t.kind = 'eoa'
    where p.ethereum_token = '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1'
        and p.withdrawn_at >= '2026-10-01 00:00:00+00' and p.withdrawn_at < '2026-11-01 00:00:00+00'
    group by 1, 2, 3
)

select chain, from_address, to_address, round(value / 1e18, 6) as sqd, transfers
from (
    select * from same_chain
    union all
    select * from cross_chain
) as edges
order by value desc, chain, from_address, to_address
