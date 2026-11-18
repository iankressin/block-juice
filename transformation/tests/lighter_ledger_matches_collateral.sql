-- Lists each pair of consecutive readings of a Lighter account whose change in collateral differs from the
-- sum of the account's USDC perps amounts in lighter_account_ledger between them, in (read_at 1, read_at 2].
-- collateral leaves out unrealized pnl, so the ledger expects it to move by money moves, realized pnl, fees
-- and funding (catalog/vendors/lighter/NOTES.md, Account value). The funding sign is L21's and the pnl scale
-- plan 1's P9.
-- A pair counts only when:
--   - every position in both readings has margin_mode 0: an isolated position holds margin of its own, and
--     how that shows in collateral is unproven;
--   - no ledger row of the account between them has a null amount, since its effect is unknown;
--   - the account has a fill at or before the first reading and one after the second, so the loaded fills
--     and funding cover the whole span: plan 1 loads fills from daily S3 files, which lag the readings by a
--     day or more. An exit does not count as that proof: exits come from the Explorer log, which is
--     current, so a later exit says nothing about whether the fills have caught up.
-- The sum is the difference of the USDC perps cumulative_amount carried to each reading. Readings and
-- ledger rows are sorted together per account, and running counts give the rows summed, the funding rounding
-- and the null-amount rows up to each reading, so the test costs one sort, not one ledger scan per pair.
-- The tolerance is 0.000002 for each row summed, for fees and pnl rounded to 6 decimals, plus
-- |position| × 0.5 × 10^-8 for each funding row: value_usdc_per_unit has 8 decimals, so a funding row can
-- miss Lighter's booked amount by that much (L21). It warns, not fails: a position in a market whose fills
-- or rates are not loaded moves collateral with no ledger row.
{{ config(severity='warn') }}

with fill_spans as (
    select account_index, min(event_time) as first_fill_time, max(event_time) as last_fill_time
    from {{ ref('lighter_account_ledger') }}
    where kind = 'fill'
    group by account_index
),

isolated as (
    select distinct account_index, read_at
    from {{ ref('lighter_account_position_snapshots') }}
    where margin_mode is distinct from 0
),

-- At one time, ledger rows sort before a reading, since the reading counts rows at or before read_at.
points as (
    select
        account_index,
        event_time as at,
        0 as is_reading,
        id,
        asset = 'USDC' and route = 'perps' as is_usdc_perps,
        case when asset = 'USDC' and route = 'perps' then cumulative_amount end as usdc_cumulative,
        case when kind = 'funding' then abs(position_after) * 0.000000005 else 0 end as funding_rounding,
        case when amount is null then 1 else 0 end as unknown_row,
        null::numeric as collateral
    from {{ ref('lighter_account_ledger') }}

    union all

    select account_index, read_at, 1, id, false, null::numeric, 0, 0, collateral
    from {{ ref('lighter_account_snapshots') }}
),

running as (
    select
        *,
        count(*) filter (where is_usdc_perps) over up_to_here as usdc_rows,
        sum(funding_rounding) over up_to_here as funding_rounding_so_far,
        sum(unknown_row) over up_to_here as unknown_rows
    from points
    window up_to_here as (
        partition by account_index
        order by at, is_reading, id
        rows between unbounded preceding and current row
    )
),

-- Each reading takes the cumulative_amount of the last USDC perps row before it: usdc_rows counts those
-- rows, so the first row of each count is the one that set it, and before the first there is none.
readings as (
    select
        account_index,
        is_reading,
        at as read_at,
        collateral,
        usdc_rows,
        funding_rounding_so_far,
        unknown_rows,
        coalesce(
            first_value(usdc_cumulative) over (
                partition by account_index, usdc_rows
                order by at, is_reading, id
            ),
            0
        ) as usdc_total
    from running
),

pairs as (
    select
        account_index,
        lag(read_at) over by_reading as previous_read_at,
        read_at,
        collateral - lag(collateral) over by_reading as collateral_change,
        usdc_total - lag(usdc_total) over by_reading as ledger_change,
        usdc_rows - lag(usdc_rows) over by_reading as rows_summed,
        funding_rounding_so_far - lag(funding_rounding_so_far) over by_reading as funding_rounding,
        unknown_rows - lag(unknown_rows) over by_reading as unknown_rows_between
    from readings
    where is_reading = 1
    window by_reading as (partition by account_index order by read_at)
),

compared as (
    select
        pairs.account_index,
        pairs.previous_read_at,
        pairs.read_at,
        pairs.collateral_change,
        pairs.ledger_change,
        pairs.rows_summed,
        0.000002 * pairs.rows_summed + pairs.funding_rounding as tolerance
    from pairs
    inner join fill_spans
        on fill_spans.account_index = pairs.account_index
        and fill_spans.first_fill_time <= pairs.previous_read_at
        and fill_spans.last_fill_time > pairs.read_at
    where pairs.previous_read_at is not null
        and pairs.unknown_rows_between = 0
        and not exists (
            select 1
            from isolated
            where isolated.account_index = pairs.account_index
                and isolated.read_at in (pairs.previous_read_at, pairs.read_at)
        )
)

select *
from compared
where abs(collateral_change - ledger_change) > tolerance
