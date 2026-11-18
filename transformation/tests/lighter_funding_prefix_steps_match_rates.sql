-- Lists each step of a market's funding_rate_prefix_sum, as the listed accounts' TradeWithFunding entries
-- carry it, that differs from the hourly rates in lighter_funding_rates. At each hour mark the prefix steps
-- by round(10^8 × value_usdc_per_unit), up when direction is long and down when short
-- (catalog/vendors/lighter/NOTES.md, Funding prefix sums, L21). int_lighter_funding_payments rests on that
-- rule and on the sign it gives. Each prefix value counts from the first entry that carries it, and a step
-- covers the hour marks after the first entry with the older value, up to the first with the newer one. A
-- step is compared only when lighter_funding_rates has every hour mark it covers, since markets outside the
-- fundings source's markets.json have no rates. It warns, not fails: a market whose entries are an hour or
-- more apart can see a value first just after the mark that set it, so that mark falls outside its step.
{{ config(severity='warn') }}

with entries as (
    select
        (pubdata ->> 'market_index')::integer as market_id,
        (pubdata ->> 'funding_rate_prefix_sum')::numeric as prefix_sum,
        log_time,
        hash
    from {{ ref('stg_lighter__account_logs') }}
    where pubdata_type = 'TradeWithFunding'
),

-- An entry starts a new value when its prefix differs from the entry before it in the same market.
changes as (
    select
        market_id,
        prefix_sum,
        log_time,
        hash,
        lag(prefix_sum) over (partition by market_id order by log_time, hash) as previous_entry_prefix_sum
    from entries
),

steps as (
    select
        market_id,
        prefix_sum,
        log_time as first_seen,
        lag(prefix_sum) over (partition by market_id order by log_time, hash) as previous_prefix_sum,
        lag(log_time) over (partition by market_id order by log_time, hash) as previous_first_seen
    from changes
    where previous_entry_prefix_sum is distinct from prefix_sum
),

compared as (
    select
        steps.market_id,
        steps.previous_first_seen,
        steps.first_seen,
        steps.previous_prefix_sum,
        steps.prefix_sum,
        steps.prefix_sum - steps.previous_prefix_sum as step,
        coalesce(sum(
            case rates.direction
                when 'long' then round(power(10::numeric, 8) * rates.value_usdc_per_unit)
                when 'short' then -round(power(10::numeric, 8) * rates.value_usdc_per_unit)
            end
        ), 0) as rates_step,
        count(rates.funding_time) as rate_hours,
        (
            select count(*)
            from generate_series(
                (date_trunc('hour', steps.previous_first_seen at time zone 'UTC') + interval '1 hour') at time zone 'UTC',
                steps.first_seen,
                interval '1 hour'
            )
        ) as hour_marks
    from steps
    left join {{ ref('lighter_funding_rates') }} as rates
        on rates.market_id = steps.market_id
        and rates.funding_time > steps.previous_first_seen
        and rates.funding_time <= steps.first_seen
    where steps.previous_prefix_sum is not null
    group by 1, 2, 3, 4, 5
)

select market_id, previous_first_seen, first_seen, previous_prefix_sum, prefix_sum, step, rates_step
from compared
where rate_hours = hour_marks
    and step <> rates_step
