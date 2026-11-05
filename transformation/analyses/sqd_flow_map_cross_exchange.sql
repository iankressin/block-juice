-- Every address that is no exchange yet got SQD from one exchange and sent SQD to a different exchange in
-- October 2026, on Arbitrum or Base, most SQD first: which exchanges it took from and paid into, and how
-- much. Exchange addresses and their deposit addresses count as the exchange.
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

taken as (
    select target as wallet, target_group as wallet_group, source as exchange, sum(value) as value
    from sides
    where source_group = 'exchange' and target_group <> 'exchange'
    group by 1, 2, 3
),

paid as (
    select source as wallet, source_group as wallet_group, target as exchange, sum(value) as value
    from sides
    where target_group = 'exchange' and source_group <> 'exchange'
    group by 1, 2, 3
),

movers as (
    select distinct t.wallet
    from taken as t
    join paid as p on p.wallet = t.wallet and p.exchange <> t.exchange
)

select
    m.wallet,
    min(t.wallet_group) as wallet_kind,
    string_agg(distinct t.exchange, ', ' order by t.exchange) as took_from,
    (select string_agg(distinct p.exchange, ', ' order by p.exchange) from paid as p where p.wallet = m.wallet) as paid_into,
    round(sum(t.value) / 1e18, 6) as sqd_from_exchanges,
    round((select sum(p.value) from paid as p where p.wallet = m.wallet) / 1e18, 6) as sqd_to_exchanges
from movers as m
join taken as t on t.wallet = m.wallet
group by m.wallet
order by sum(t.value) desc, m.wallet
