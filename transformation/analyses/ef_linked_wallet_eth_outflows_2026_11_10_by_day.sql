-- ETH the wallet Lookonchain links to the Ethereum Foundation sent out per UTC day and class, over Ethereum
-- blocks 26380784 to 26387956 (2026-11-10 UTC). A block belongs to the day its timestamp falls in, so each
-- day starts at its first block at or after 00:00:00 UTC.
select
    (block_timestamp at time zone 'UTC')::date as day,
    outflow_class,
    count(*) as outflows,
    sum(eth) as eth
from {{ ref('wallet_eth_outflows') }}
where chain = 'ethereum'
    and from_address = '0x5cbc6299fab3320e7758ac97fd4ca45e5b722059'
    and block_number between 26380784 and 26387956
group by 1, 2
order by 1, 2
