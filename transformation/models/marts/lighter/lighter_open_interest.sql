-- One end-of-hour open interest reading per Lighter market. hour is the start of the hour the reading
-- closes. Lighter's file names the market by symbol only, so there is no market_id here.
select
    id,
    hour,
    symbol,
    open_interest,
    mark_price,
    open_interest_usd
from {{ ref('stg_lighter__open_interest') }}
