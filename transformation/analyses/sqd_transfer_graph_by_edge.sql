-- The edges of the SQD transfer graph over October 2026 on Arbitrum and Base: one row per sender and
-- recipient, with the transfers and SQD that went from one to the other, per chain and in total, most SQD
-- first. Transfers to self, mints and burns are left out. The blocks and tokens are those of
-- answers/sqd-transfer-graph/question.yaml.
with sqd as (
    select chain, from_address, to_address, value
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
)

select
    from_address,
    to_address,
    round(sum(value) / 1e18, 6) as sqd,
    count(*) as transfers,
    round(coalesce(sum(value) filter (where chain = 'arbitrum'), 0) / 1e18, 6) as arbitrum_sqd,
    count(*) filter (where chain = 'arbitrum') as arbitrum_transfers,
    round(coalesce(sum(value) filter (where chain = 'base'), 0) / 1e18, 6) as base_sqd,
    count(*) filter (where chain = 'base') as base_transfers
from sqd
group by from_address, to_address
order by sum(value) desc, from_address, to_address
