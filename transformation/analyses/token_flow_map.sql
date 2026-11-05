-- How many addresses that are no exchange took the token out of one exchange and paid it into a different
-- one in the token's windows. token_flow_map_cross_exchange lists them.
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

taken as (
    select distinct target as wallet, source as exchange
    from sides
    where source_group = 'exchange' and target_group <> 'exchange'
),

paid as (
    select distinct source as wallet, target as exchange
    from sides
    where target_group = 'exchange' and source_group <> 'exchange'
)

select count(distinct t.wallet) as cross_exchange_wallets
from taken as t
join paid as p on p.wallet = t.wallet and p.exchange <> t.exchange
