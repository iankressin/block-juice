-- One row per outcome token and minute: the price chart in 1-minute OHLC. Prices are pUSD per share;
-- shares_volume is outcome tokens and usdc_volume pUSD before fees.
-- A market with two outcomes has one order book, so a trade of one token at price also prices the other
-- at 1 - price (plan Decision 4). OHLC take both legs, in (block_number, log_index) order. trades and the
-- volumes count only the token's own trades, so summing them over a market's tokens counts each trade
-- once; a minute in which only the other token traded has prices and zero volume (progress R30).
with trades as (
    select token_id, block_timestamp, block_number, log_index, price, shares, usdc
    from {{ ref('polymarket_trades') }}
),

tokens as (
    select token_id, condition_id, outcome, complement_token_id
    from {{ ref('int_polymarket_outcome_tokens') }}
),

legs as (
    select token_id, block_timestamp, block_number, log_index, price, shares, usdc, true as own
    from trades
    union all
    select t.complement_token_id, tr.block_timestamp, tr.block_number, tr.log_index, 1 - tr.price, 0, 0, false
    from trades as tr
    inner join tokens as t on t.token_id = tr.token_id
    where t.complement_token_id is not null
)

select
    l.token_id,
    date_trunc('minute', l.block_timestamp) as minute,
    t.condition_id,
    t.outcome,
    (array_agg(l.price order by l.block_number, l.log_index))[1] as open,
    max(l.price) as high,
    min(l.price) as low,
    (array_agg(l.price order by l.block_number desc, l.log_index desc))[1] as close,
    count(*) filter (where l.own) as trades,
    sum(l.shares) as shares_volume,
    sum(l.usdc) as usdc_volume
from legs as l
inner join tokens as t on t.token_id = l.token_id
group by l.token_id, date_trunc('minute', l.block_timestamp), t.condition_id, t.outcome
