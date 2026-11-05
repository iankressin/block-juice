-- The token moved in its windows from each group of entity to each other: exchange, contract, eoa,
-- bridge. Moves between an exchange's own addresses are left out.
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
)

select
    source_group,
    target_group,
    round(sum(value) / {{ token_unit() }}, 6) as amount,
    count(*) as transfers,
    count(distinct source) as sources,
    count(distinct target) as targets
from sides
where source <> target
group by source_group, target_group
order by sum(value) desc
