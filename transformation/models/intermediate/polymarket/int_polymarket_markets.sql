-- One row per condition of a Gamma v1 market, with Gamma's names for it. A placeholder market has no
-- condition and gives no row; Protocol V2 markets (Task 13) are not here yet.
-- Gamma could list one condition in several markets. Then the market with the lowest id, as a number,
-- wins, so every run picks the same one: ids are digits, so the shorter one is lower.
select distinct on (condition_id)
    condition_id,
    market_id,
    question,
    slug,
    event_id,
    event_title,
    neg_risk,
    outcomes,
    end_date,
    -- A sports market: Gamma gives it a sportsMarketType, or charges it a sports fee schedule. Some
    -- sports-fee markets, such as futures, have no sportsMarketType.
    sports_market_type is not null or coalesce(fee_type like 'sports%', false) as is_sports,
    sports_market_type,
    series_slug,
    game_start_time
from {{ ref('stg_polymarket__markets') }}
where protocol_version = 'v1'
    and condition_id is not null
order by condition_id, length(market_id), market_id
