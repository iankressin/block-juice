-- Lists each market whose size_decimals or price_decimals differ between readings. int_lighter_trades
-- scales every trade by its market's latest decimals, so one change would mis-scale the older trades.
-- The build fails then. Trades would need scaling by the reading in effect at trade time.
{{ config(severity='error') }}

select
    market_id,
    count(distinct size_decimals) as size_decimals_values,
    count(distinct price_decimals) as price_decimals_values
from {{ ref('stg_lighter__markets') }}
group by market_id
having count(distinct size_decimals) > 1
    or count(distinct price_decimals) > 1
