-- The number of Uniswap v3 swaps that traded UNI on Ethereum in the answer's window.
-- volume has their UNI volume, and by_pool each pool's share.
select count(*) as swaps
from {{ ref('dex_trades') }}
where chain = 'ethereum'
    and version = 'v3'
    and {{ in_window('block_number', 'ethereum') }}
    and '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984' in (token_bought, token_sold)
