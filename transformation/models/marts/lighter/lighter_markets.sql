-- One Lighter market, perp or spot, as of the latest run. market_id is the public id the API uses.
-- size_decimals and price_decimals say how many decimal places an integer size or price carries, and
-- quote_decimals the same for a quote amount. maker_fee_pct and taker_fee_pct are percents.
select
    market_id,
    symbol,
    market_type,
    base_asset_id,
    quote_asset_id,
    status,
    size_decimals,
    price_decimals,
    quote_decimals,
    maker_fee_pct,
    taker_fee_pct,
    min_base_amount,
    min_quote_amount,
    created_at,
    read_at
from {{ ref('int_lighter_markets') }}
