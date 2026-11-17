-- One Lighter market: its latest reading. A market's settings can change between runs, so each
-- market keeps the row with the latest read_at. Other Lighter models join on market_id.
select distinct on (market_id) *
from {{ ref('stg_lighter__markets') }}
order by market_id, read_at desc
