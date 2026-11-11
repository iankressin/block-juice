-- ETH the wallet Lookonchain links to the Ethereum Foundation sent out over Ethereum blocks 26380784 to
-- 26387956 (2026-11-10 UTC), by class and venue.
select outflow_class, venue, count(*) as outflows, sum(eth) as eth
from {{ ref('wallet_eth_outflows') }}
where chain = 'ethereum'
    and from_address = '0x5cbc6299fab3320e7758ac97fd4ca45e5b722059'
    and block_number between 26380784 and 26387956
group by outflow_class, venue
order by eth desc
