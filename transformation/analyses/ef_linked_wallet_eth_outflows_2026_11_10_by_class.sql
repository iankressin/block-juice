-- ETH the wallet Lookonchain links to the Ethereum Foundation sent out over the answer's window, by class
-- and venue.
select outflow_class, venue, count(*) as outflows, sum(eth) as eth
from {{ ref('wallet_eth_outflows') }}
where chain = 'ethereum'
    and from_address = '0x5cbc6299fab3320e7758ac97fd4ca45e5b722059'
    and {{ in_window('block_number', 'ethereum') }}
group by outflow_class, venue
order by eth desc
