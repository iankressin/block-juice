with classified as (
    {{ classified_transfers() }}
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
    join ({{ token_bridge_transfers() }}) as w on w.chain = p.from_chain and w.id = p.withdrawal_id
    left join {{ ref('address_labels') }} as f on f.chain = p.from_chain and f.address = p.from_address
    left join {{ ref('address_labels') }} as t on t.chain = p.to_chain and t.address = p.to_address
    group by 1, 2, 3, 4, 5, 6
)

select source, source_group, target, target_group, chain, category, round(value / {{ token_unit() }}, 6) as amount, transfers
from (
    select * from same_chain
    union all
    select * from cross_chain
) as edges
order by value desc, source, target, chain
