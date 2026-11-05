-- The nodes of the SQD transfer graph over October 2026 on Arbitrum and Base: each address with how many
-- addresses it sent SQD to and got SQD from, and the SQD on those edges, most SQD moved first. The same
-- transfers as sqd_transfer_graph_by_edge.
with sqd as (
    select from_address, to_address, value
    from {{ ref('erc20_transfers') }}
    where (
        (
            chain = 'arbitrum'
            and token = '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1'
            and block_number between 510496864 and 520129273
        ) or (
            chain = 'base'
            and token = '0xd4554bea546efa83c1e6b389ecac40ea999b3e78'
            and block_number between 52011727 and 53350926
        )
    )
    and from_address <> to_address
    and '0x0000000000000000000000000000000000000000' not in (from_address, to_address)
),

sides as (
    select from_address as address, to_address as other, 'out' as direction, value from sqd
    union all
    select to_address as address, from_address as other, 'in' as direction, value from sqd
)

select
    address,
    count(distinct other) filter (where direction = 'out') as sent_to,
    count(distinct other) filter (where direction = 'in') as received_from,
    round(coalesce(sum(value) filter (where direction = 'out'), 0) / 1e18, 6) as sqd_sent,
    round(coalesce(sum(value) filter (where direction = 'in'), 0) / 1e18, 6) as sqd_received,
    round((coalesce(sum(value) filter (where direction = 'in'), 0) - coalesce(sum(value) filter (where direction = 'out'), 0)) / 1e18, 6) as net_sqd
from sides
group by address
order by sum(value) desc, address
