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
--     current, so a later exit says nothing about whether the fills have caught up;
--   - no gap in the account's loaded fills of any market overlaps the span. A gap lies between two fills
--     of a market where the later one's position_before differs from the earlier one's position_after, so
--     trades between them were not loaded, as for an account lighter-trades loads only through its trades
--     with the accounts it lists. A market's first fill with a position_before other than 0 opens a gap
--     from the start of time. The chain comes from lighter_account_fills, not from the ledger;
--   - neither reading holds a position other than 0 in a market with no loaded fills for the account,
--     whose funding and trades the ledger cannot hold.
-- What it cannot see: unloaded trades that leave the position where it was, either between two fills that
-- still chain or in a market with no loaded fills where the account holds nothing at either reading. Their
-- pnl and fees move collateral with no ledger row, and the pair lists.
-- The sum is the difference of the USDC perps cumulative_amount carried to each reading. cumulative_amount
-- gives rows at one time the same total, so the row a reading takes holds every row at or before read_at.
-- Readings, ledger rows and the edges of gaps are sorted together per account, and running counts give
-- the rows summed, the funding rounding, the null-amount rows and the gaps begun and ended up to each
-- reading, so the test costs a few sorts, not one ledger scan per pair. A gap overlaps (read_at 1,
-- read_at 2] when it begins before read_at 2 and does not end by read_at 1, so the gaps that overlap are
-- those begun by read_at 2 less those ended by read_at 1.
-- The tolerance is 0.000002 for each row summed, for fees and pnl rounded to 6 decimals, plus
-- |position| × 0.5 × 10^-8 for each funding row: value_usdc_per_unit has 8 decimals, so a funding row can
-- miss Lighter's booked amount by that much (L21). It warns, not fails, since the readings come from a
-- live API and the blind spots above can list a pair.
{{ config(severity='warn') }}

with fill_spans as (
    select account_index, min(event_time) as first_fill_time, max(event_time) as last_fill_time
    from {{ ref('lighter_account_ledger') }}
    where kind = 'fill'
    group by account_index
),

-- Each fill of a ledger account, in its market's order, with the position_after of the fill before it.
chain as (
    select
        source.account_index,
        source.market_id,
        source.trade_time,
        source.position_before,
        lag(source.position_after) over (
            partition by source.account_index, source.market_id
            order by source.trade_time, source.trade_id, source.id
        ) as previous_position_after,
        lag(source.trade_time) over (
            partition by source.account_index, source.market_id
            order by source.trade_time, source.trade_id, source.id
        ) as previous_trade_time
    from {{ ref('lighter_account_fills') }} as source
    inner join {{ ref('lighter_account_ledger') }} as ledger
        on ledger.id = 'fill:' || source.id
),

gaps as (
    select
        account_index,
        coalesce(previous_trade_time, '-infinity'::timestamptz) as began_after,
        trade_time as ended_at
    from chain
    where position_before is distinct from coalesce(previous_position_after, 0)
),

isolated as (
    select distinct account_index, read_at
    from {{ ref('lighter_account_position_snapshots') }}
    where margin_mode is distinct from 0
),

-- A reading that holds a position in a market where the account has no loaded fill.
unloaded_positions as (
    select distinct snapshots.account_index, snapshots.read_at
    from {{ ref('lighter_account_position_snapshots') }} as snapshots
    where snapshots.position <> 0
        and not exists (
            select 1
            from {{ ref('lighter_account_ledger') }} as ledger
            where ledger.kind = 'fill'
                and ledger.account_index = snapshots.account_index
                and ledger.market_id = snapshots.market_id
        )
),

-- At one time a ledger row or a gap's end sorts before a reading, which counts them as at or before
-- read_at, and a gap's start sorts after it: a gap that begins after the fill at read_at begins after the
-- reading.
points as (
    select
        account_index,
        event_time as at,
        0 as sort_order,
        id,
        asset = 'USDC' and route = 'perps' as is_usdc_perps,
        case when asset = 'USDC' and route = 'perps' then cumulative_amount end as usdc_cumulative,
        case when kind = 'funding' then abs(position_after) * 0.000000005 else 0 end as funding_rounding,
        case when amount is null then 1 else 0 end as unknown_row,
        0 as gap_began,
        0 as gap_ended,
        null::numeric as collateral
    from {{ ref('lighter_account_ledger') }}

    union all

    select account_index, ended_at, 0, null, false, null, 0, 0, 0, 1, null
    from gaps

    union all

    select account_index, read_at, 1, id, false, null, 0, 0, 0, 0, collateral
    from {{ ref('lighter_account_snapshots') }}

    union all

    select account_index, began_after, 2, null, false, null, 0, 0, 1, 0, null
    from gaps
),

running as (
    select
        *,
        count(*) filter (where is_usdc_perps) over up_to_here as usdc_rows,
        sum(funding_rounding) over up_to_here as funding_rounding_so_far,
        sum(unknown_row) over up_to_here as unknown_rows,
        sum(gap_began) over up_to_here as gaps_begun,
        sum(gap_ended) over up_to_here as gaps_ended
    from points
    window up_to_here as (
        partition by account_index
        order by at, sort_order, id
        rows between unbounded preceding and current row
    )
),

-- Each reading takes the cumulative_amount of the last USDC perps row before it: usdc_rows counts those
-- rows, so the first row of each count is the one that set it, and before the first there is none.
readings as (
    select
        account_index,
        sort_order,
        at as read_at,
        collateral,
        usdc_rows,
        funding_rounding_so_far,
        unknown_rows,
        gaps_begun,
        gaps_ended,
        coalesce(
            first_value(usdc_cumulative) over (
                partition by account_index, usdc_rows
                order by at, sort_order, id
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
        unknown_rows - lag(unknown_rows) over by_reading as unknown_rows_between,
        gaps_begun - lag(gaps_ended) over by_reading as gaps_between
    from readings
    where sort_order = 1
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
        and pairs.gaps_between = 0
        and not exists (
            select 1
            from isolated
            where isolated.account_index = pairs.account_index
                and isolated.read_at in (pairs.previous_read_at, pairs.read_at)
        )
        and not exists (
            select 1
            from unloaded_positions
            where unloaded_positions.account_index = pairs.account_index
                and unloaded_positions.read_at in (pairs.previous_read_at, pairs.read_at)
        )
)

select *
from compared
where abs(collateral_change - ledger_change) > tolerance
