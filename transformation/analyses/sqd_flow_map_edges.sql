-- The edges of the SQD entity graph of October 2026, most SQD first: from one entity to another, per
-- chain and category, with each end's group. An exchange's addresses and deposit addresses are one entity,
-- named for the exchange; a mint or burn's other end is bridge:<chain>. A withdrawal from one L2 that pairs
-- with a deposit into the other through Ethereum (bridge_pairs) is an edge across chains, such as
-- arbitrum>base. Moves between an exchange's own addresses are left out.
{%- set windows = [
    {'chain': 'arbitrum', 'token': '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1', 'blocks': [510496864, 520129273]},
    {'chain': 'base', 'token': '0xd4554bea546efa83c1e6b389ecac40ea999b3e78', 'blocks': [52011727, 53350926]},
] %}
with classified as (
    {{ classified_transfers(windows) }}
),

-- Each transfer between entities: an exchange's addresses and deposit addresses are the exchange, a mint
-- or burn's zero address is the chain's bridge, any other address is itself.
sides as (
    select
        chain,
        category,
        value,
        case
            when from_kind in ('exchange', 'deposit') then from_exchange
            when from_kind = 'bridge' then 'bridge:' || chain
            else from_address
        end as source,
        case when from_kind = 'deposit' then 'exchange' else from_kind end as source_group,
        case
            when to_kind in ('exchange', 'deposit') then to_exchange
            when to_kind = 'bridge' then 'bridge:' || chain
            else to_address
        end as target,
        case when to_kind = 'deposit' then 'exchange' else to_kind end as target_group
    from classified
),

same_chain as (
    select source, source_group, target, target_group, chain, category, sum(value) as value, count(*) as transfers
    from sides
    where source <> target
    group by 1, 2, 3, 4, 5, 6
),

cross_chain as (
    select
        p.from_address as source,
        coalesce(f.kind, 'unknown') as source_group,
        p.to_address as target,
        coalesce(t.kind, 'unknown') as target_group,
        p.from_chain || '>' || p.to_chain as chain,
        'bridge' as category,
        sum(p.amount) as value,
        count(*) as transfers
    from {{ ref('bridge_pairs') }} as p
    left join {{ ref('address_labels') }} as f on f.chain = p.from_chain and f.address = p.from_address
    left join {{ ref('address_labels') }} as t on t.chain = p.to_chain and t.address = p.to_address
    where p.ethereum_token = '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1'
        and p.withdrawn_at >= '2026-10-01 00:00:00+00' and p.withdrawn_at < '2026-11-01 00:00:00+00'
    group by 1, 2, 3, 4, 5, 6
)

select source, source_group, target, target_group, chain, category, round(value / 1e18, 6) as sqd, transfers
from (
    select * from same_chain
    union all
    select * from cross_chain
) as edges
order by value desc, source, target, chain
