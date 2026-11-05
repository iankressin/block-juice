-- Each address's net SQD over October 2026 on Arbitrum and Base: SQD received minus SQD sent, per chain
-- and added up over both, most first. The zero address is left out: mints come from it and burns go to
-- it. The blocks are October 2026 UTC on each chain, from answers/sqd-net-accumulators/question.yaml.
with sqd as (
    select chain, from_address, to_address, value
    from {{ ref('erc20_transfers') }}
    where (
        chain = 'arbitrum'
        and token = '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1'
        and block_number between 510496864 and 520129273
    ) or (
        chain = 'base'
        and token = '0xd4554bea546efa83c1e6b389ecac40ea999b3e78'
        and block_number between 52011727 and 53350926
    )
),

flows as (
    select chain, to_address as address, value as received, 0 as sent, 1 as transfers_in, 0 as transfers_out
    from sqd

    union all

    select chain, from_address as address, 0 as received, value as sent, 0 as transfers_in, 1 as transfers_out
    from sqd
)

select
    address,
    round(sum(received - sent) / 1e18, 6) as net_sqd,
    round(sum(received - sent) filter (where chain = 'arbitrum') / 1e18, 6) as arbitrum_net_sqd,
    round(sum(received - sent) filter (where chain = 'base') / 1e18, 6) as base_net_sqd,
    round(sum(received) / 1e18, 6) as received_sqd,
    round(sum(sent) / 1e18, 6) as sent_sqd,
    sum(transfers_in) as transfers_in,
    sum(transfers_out) as transfers_out
from flows
where address <> '0x0000000000000000000000000000000000000000'
group by address
order by sum(received - sent) desc, address
