-- One row of headline figures for the loaded window: fills and volume from polymarket_trades, markets from
-- polymarket_markets, wallets from polymarket_market_participants, candles from polymarket_price_candles.
with trades as (
    select
        count(*) as fills,
        sum(usdc) as volume_usdc,
        sum(fee_usdc) as fees_usdc,
        sum(shares) as shares_traded,
        sum(usdc) filter (where maker_side = 'buy') as maker_buy_usdc,
        sum(usdc) filter (where maker_side = 'sell') as maker_sell_usdc,
        count(distinct condition_id) as markets_traded,
        count(distinct maker) as makers,
        min(block_number) as first_block,
        max(block_number) as last_block,
        min(block_timestamp) as first_fill_at,
        max(block_timestamp) as last_fill_at
    from {{ ref('polymarket_trades') }}
),

traded as (
    select distinct condition_id from {{ ref('polymarket_trades') }}
),

markets as (
    select
        count(*) as markets_in_catalog,
        count(*) filter (where resolved_at is not null) as markets_resolved,
        count(*) filter (where history_complete) as markets_history_complete,
        count(distinct event_id) as events_in_catalog
    from {{ ref('polymarket_markets') }}
),

traded_events as (
    select count(distinct m.event_id) as events_traded
    from traded as t
    inner join {{ ref('polymarket_markets') }} as m on m.condition_id = t.condition_id
),

participants as (
    select
        count(*) as participant_rows,
        count(distinct wallet) as wallets,
        count(distinct wallet) filter (where trades > 0) as traders,
        count(distinct condition_id) as markets_with_activity
    from {{ ref('polymarket_market_participants') }}
),

candles as (
    select count(*) as candles, count(distinct token_id) as tokens_with_candles
    from {{ ref('polymarket_price_candles') }}
)

select *
from trades
cross join markets
cross join traded_events
cross join participants
cross join candles
