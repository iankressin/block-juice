-- Uniswap v3 swaps that traded UNI on Ethereum in the answer's window, per pool:
-- the number of swaps and the sum of each swap's absolute UNI amount, in UNI. UNI is the swap's bought
-- or sold token, so every pool that holds UNI counts, whatever the other token.
select
    trades.pool,
    count(*) as swaps,
    sum(case when trades.token_bought = uni.token then trades.amount_bought else trades.amount_sold end)
        / power(10::numeric, uni.decimals) as uni_volume
from {{ ref('dex_trades') }} as trades
inner join {{ ref('tokens') }} as uni
    on uni.chain = trades.chain
    and uni.token = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984'
    and uni.token in (trades.token_bought, trades.token_sold)
where trades.chain = 'ethereum'
    and trades.version = 'v3'
    and {{ in_window('trades.block_number', 'ethereum') }}
group by trades.pool, uni.decimals
order by swaps desc, trades.pool
