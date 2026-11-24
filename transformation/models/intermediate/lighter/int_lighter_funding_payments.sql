-- The funding one listed Lighter account paid or received at one hour mark on one perp market. A listed
-- account is one in stg_lighter__account_logs, so an account in the account-log source's addresses.json
-- whose log holds no entry of a ledger type since START_TIME, such as one that only made plain trades, has
-- no rows here; lighter_listed_accounts_have_log_entries warns about it. Lighter books funding at each
-- hour mark on every open position, with no log entry, so it comes from plan 1's data
-- (catalog/vendors/lighter/NOTES.md, Funding prefix sums and Account value, L21):
--   position is the account's position in the market at the mark: the position_after of its last fill
--   there before funding_time, or, before its first fill there, that fill's position_before.
--   amount is -position × value_usdc_per_unit when direction is long and +position × value when short, so
--   with direction long a long pays and a short receives (L21).
-- Hours run from the account's first loaded perp fill in any market to the end of the last UTC day in
-- lighter_trades, since fills before and after that are not loaded. An hour with no position has no row.
-- value_usdc_per_unit has 8 decimals, so amount can miss Lighter's booked amount by up to
-- |position| × 0.5 × 10^-8 (NOTES.md, Funding prefix sums).
-- lighter_account_fills holds only the trades the lighter-trades source loads, so an account it does not
-- load in full, such as one loaded only through its trades with an account it lists, has gaps. Each fill's
-- position_before comes from S3, so a gap shows where a fill's position_before differs from the
-- position_after of the fill before it. The position at every mark between those two fills is unknown,
-- and those marks have no row. What the data cannot show is a gap before such an account's first loaded
-- fill in a market or after its last: there the position is the first fill's position_before or the last
-- fill's position_after, which assumes no trade went unloaded. Nor can it show a gap whose unloaded trades
-- net to zero, so that a fill's position_before equals the position_after of the fill before it: the marks
-- between carry that position, though it may have moved and come back. Listing the account in
-- lighter-trades' addresses.json loads all its trades and makes those hours right.
with listed as (
    select distinct account_index from {{ ref('stg_lighter__account_logs') }}
),

fills as (
    select
        fills.id,
        fills.account_index,
        fills.market_id,
        fills.trade_id,
        fills.trade_time,
        fills.position_before,
        fills.position_after
    from {{ ref('lighter_account_fills') }} as fills
    inner join listed
        on listed.account_index = fills.account_index
    inner join {{ ref('lighter_markets') }} as markets
        on markets.market_id = fills.market_id
        and markets.market_type = 'perp'
),

loaded as (
    select
        (date_trunc('day', max(trade_time) at time zone 'UTC') + interval '1 day') at time zone 'UTC' as end_time
    from {{ ref('lighter_trades') }}
),

spans as (
    select account_index, min(trade_time) as first_fill_time
    from fills
    group by account_index
),

-- The position each market held before the account's first fill there.
openings as (
    select distinct on (account_index, market_id)
        account_index,
        market_id,
        position_before as opening_position
    from fills
    order by account_index, market_id, trade_time, trade_id, id
),

marks as (
    select
        openings.account_index,
        openings.market_id,
        openings.opening_position,
        mark.funding_time
    from openings
    inner join spans
        on spans.account_index = openings.account_index
    cross join loaded
    cross join lateral generate_series(
        (date_trunc('hour', spans.first_fill_time at time zone 'UTC') + interval '1 hour') at time zone 'UTC',
        loaded.end_time,
        interval '1 hour'
    ) as mark (funding_time)
),

-- A fill counts from the first hour mark after it, and breaks the chain when its position_before differs
-- from the position_after of the fill before it.
chained as (
    select
        *,
        (date_trunc('hour', trade_time at time zone 'UTC') + interval '1 hour') at time zone 'UTC' as funding_time,
        coalesce(
            position_before <> lag(position_after) over (
                partition by account_index, market_id
                order by trade_time, trade_id, id
            ),
            false
        ) as breaks_chain
    from fills
),

-- Of the fills before one mark, the last one holds. A break at the first of them hides every mark from the
-- close before it up to, not including, this one: the unloaded trades fall somewhere after that close's
-- last fill. A break at a later one hides no mark, since no mark falls between two fills of one hour.
closes as (
    select
        account_index,
        market_id,
        funding_time,
        (array_agg(position_after order by trade_time desc, trade_id desc, id desc))[1] as position_after,
        (array_agg(breaks_chain order by trade_time, trade_id, id))[1] as opens_with_break
    from chained
    group by account_index, market_id, funding_time
),

closes_ahead as (
    select
        *,
        coalesce(
            lead(opens_with_break) over (partition by account_index, market_id order by funding_time),
            false
        ) as hidden_until_next
    from closes
),

-- Each mark takes the latest close at or before it: fills_seen counts the closes so far, so all marks
-- after one close and before the next share its count.
carried as (
    select
        marks.account_index,
        marks.market_id,
        marks.funding_time,
        marks.opening_position,
        closes_ahead.position_after,
        closes_ahead.hidden_until_next,
        count(closes_ahead.position_after) over (
            partition by marks.account_index, marks.market_id
            order by marks.funding_time
            rows between unbounded preceding and current row
        ) as fills_seen
    from marks
    left join closes_ahead
        on closes_ahead.account_index = marks.account_index
        and closes_ahead.market_id = marks.market_id
        and closes_ahead.funding_time = marks.funding_time
),

positions as (
    select
        account_index,
        market_id,
        funding_time,
        case
            when fills_seen = 0 then opening_position
            else first_value(position_after) over since_close
        end as position,
        fills_seen > 0 and first_value(hidden_until_next) over since_close as hidden
    from carried
    window since_close as (partition by account_index, market_id, fills_seen order by funding_time)
)

select
    positions.account_index,
    positions.market_id,
    positions.funding_time,
    positions.position,
    rates.value_usdc_per_unit,
    rates.direction,
    case rates.direction
        when 'long' then -positions.position * rates.value_usdc_per_unit
        when 'short' then positions.position * rates.value_usdc_per_unit
    end as amount
from positions
inner join {{ ref('lighter_funding_rates') }} as rates
    on rates.market_id = positions.market_id
    and rates.funding_time = positions.funding_time
where positions.position <> 0
    and not positions.hidden
