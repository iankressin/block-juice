{{ config(tags=['reference']) }}
-- #32: swaps and UNI volume per Uniswap v3 pool holding UNI, verified on ethereum blocks 26194189 to
-- 26201364 against Dune query 9099271. The actual CTE is analyses/uni_v3_uni_swaps_2026_10_15_by_pool.sql.
with actual as (
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
        and trades.block_number between 26194189 and 26201364
    group by trades.pool, uni.decimals
)
{{ reference_mismatches(ref('reference_uni_v3_uni_swaps_2026_10_15'), 'actual', ['pool', 'swaps'], 'uni_volume', 'relative', 0.001) }}
