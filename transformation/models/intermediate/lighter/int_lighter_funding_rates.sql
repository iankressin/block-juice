-- One hourly funding rate of one Lighter perp market, with its sign. Lighter sends rate_pct unsigned
-- and gives the sign as direction: long for a positive rate, short for a negative one. So
-- signed_rate_pct is rate_pct for long and -rate_pct for short, and positive means longs pay shorts.
-- That long names the paying side is inferred from the funding page's rule, not stated by Lighter
-- for direction; see catalog/vendors/lighter/NOTES.md. A direction other than long or short gives null.
select
    id,
    market_id,
    symbol,
    funding_time,
    rate_pct,
    case direction
        when 'long' then rate_pct
        when 'short' then -rate_pct
    end as signed_rate_pct,
    value_usdc_per_unit,
    direction
from {{ ref('stg_lighter__fundings') }}
