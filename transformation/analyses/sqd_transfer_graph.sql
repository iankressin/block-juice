-- How many edges the SQD transfer graph has over October 2026 on Arbitrum and Base: pairs of addresses
-- where the first sent the second SQD. sqd_transfer_graph_by_edge lists them.
select count(*) as edges
from (
    select distinct from_address, to_address
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
) as edges
