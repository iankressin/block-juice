-- The address that gained the most SQD over October 2026 on Arbitrum and Base together: SQD received
-- minus SQD sent, the zero address left out. sqd_net_accumulators_by_wallet ranks every address with the
-- same window and tokens.
with sqd as (
    select from_address, to_address, value
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
    select to_address as address, value as net from sqd
    union all
    select from_address as address, -value as net from sqd
)

select address as top_accumulator
from flows
where address <> '0x0000000000000000000000000000000000000000'
group by address
order by sum(net) desc, address
limit 1
