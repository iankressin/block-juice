-- One hourly funding rate per Lighter perp market. funding_time is the hour mark the rate is paid at.
-- rate_pct is the percent per hour, unsigned; signed_rate_pct carries the sign, positive when longs
-- pay shorts. value_usdc_per_unit is USDC per one unit of base.
select
    id,
    market_id,
    symbol,
    funding_time,
    rate_pct,
    signed_rate_pct,
    value_usdc_per_unit,
    direction
from {{ ref('int_lighter_funding_rates') }}
