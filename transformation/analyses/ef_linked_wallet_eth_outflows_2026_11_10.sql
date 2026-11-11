-- ETH sent out over Ethereum blocks 26380784 to 26387956 (2026-11-10 UTC) by the wallet Lookonchain links
-- to the Ethereum Foundation, 0x5cbc6299fab3320e7758ac97fd4ca45e5b722059: the value of its successful
-- top-level transactions, fees left out. _by_outflow lists them, _by_class splits them by where they went.
select coalesce(sum(eth), 0) as eth_sent_out
from {{ ref('wallet_eth_outflows') }}
where chain = 'ethereum'
    and from_address = '0x5cbc6299fab3320e7758ac97fd4ca45e5b722059'
    and block_number between 26380784 and 26387956
