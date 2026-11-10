-- The UNI volume of the Uniswap v3 swaps that traded UNI on Ethereum on 2026-10-15 UTC (blocks 26194189
-- to 26201364): the sum of each swap's absolute UNI amount, in UNI, with UNI's decimals from tokens.
select
    sum(case when trades.token_bought = uni.token then trades.amount_bought else trades.amount_sold end)
        / power(10::numeric, uni.decimals) as uni
from {{ ref('dex_trades') }} as trades
inner join {{ ref('tokens') }} as uni
    on uni.chain = trades.chain
    and uni.token = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'
    and uni.token in (trades.token_bought, trades.token_sold)
where trades.chain = 'ethereum'
    and trades.version = 'v3'
    and trades.block_number between 26194189 and 26201364
group by uni.decimals
