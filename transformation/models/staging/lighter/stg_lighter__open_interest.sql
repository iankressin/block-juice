-- One end-of-hour open interest reading of one Lighter market, as the lighter-open-interest source
-- loaded it from the hourly S3 file. hour is the start of the hour the reading closes. open_interest
-- is in base units, and open_interest_usd is open_interest times mark_price. Lighter names the market
-- by symbol only. Meanings are in catalog/vendors/lighter/NOTES.md.
select
    id,
    (data ->> 'hour')::timestamptz as hour,
    data ->> 'symbol' as symbol,
    (data ->> 'open_interest')::numeric as open_interest,
    (data ->> 'mark_price')::numeric as mark_price,
    (data ->> 'open_interest_usd')::numeric as open_interest_usd,
    _loaded_at
from {{ source('lighter', 'open_interest') }}
