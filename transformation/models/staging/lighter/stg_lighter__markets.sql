-- One reading of one Lighter market, as the lighter-markets source loaded it from orderBookDetails.
-- read_at is when the run read it. The fees are percents as Lighter sends them, not parts per million.
-- Field meanings are in catalog/vendors/lighter/NOTES.md.
select
    id,
    to_timestamp((data ->> 'read_at')::bigint / 1000.0) as read_at,
    (data -> 'market' ->> 'market_id')::integer as market_id,
    data -> 'market' ->> 'symbol' as symbol,
    data -> 'market' ->> 'market_type' as market_type,
    (data -> 'market' ->> 'base_asset_id')::integer as base_asset_id,
    (data -> 'market' ->> 'quote_asset_id')::integer as quote_asset_id,
    data -> 'market' ->> 'status' as status,
    (data -> 'market' ->> 'size_decimals')::integer as size_decimals,
    (data -> 'market' ->> 'price_decimals')::integer as price_decimals,
    (data -> 'market' ->> 'supported_quote_decimals')::integer as quote_decimals,
    (data -> 'market' ->> 'maker_fee')::numeric as maker_fee_pct,
    (data -> 'market' ->> 'taker_fee')::numeric as taker_fee_pct,
    data -> 'market' ->> 'min_base_amount' as min_base_amount,
    data -> 'market' ->> 'min_quote_amount' as min_quote_amount,
    to_timestamp((data -> 'market' ->> 'created_at')::bigint / 1000.0) as created_at,
    _loaded_at
from {{ source('lighter', 'markets') }}
