-- Lists each position in Lighter's account readings that differs from the position lighter_account_ledger
-- rebuilds from fills and exits: the position_after of the account's last fill or exit in that market at or
-- before read_at, or 0 when it has none. A reading counts only when the account has a fill after read_at,
-- so the loaded fills cover it: plan 1 loads fills from daily S3 files, which lag the reading by a day or
-- more. An exit does not count as that proof: exits come from the Explorer log, which is current, so a
-- later exit says nothing about whether the fills have caught up. position is signed in both. Readings
-- and ledger rows are sorted together per account and market, and each reading takes the position of the
-- last row before it, so the test costs one sort, not one ledger scan per reading. It warns, not fails:
-- the ledger holds only the markets the lighter-trades source loads, so an open position in another market
-- lists here once its account is covered.
{{ config(severity='warn') }}

with last_fills as (
    select account_index, max(event_time) as last_fill_time
    from {{ ref('lighter_account_ledger') }}
    where kind = 'fill'
    group by account_index
),

covered as (
    select snapshots.*
    from {{ ref('lighter_account_position_snapshots') }} as snapshots
    inner join last_fills
        on last_fills.account_index = snapshots.account_index
        and last_fills.last_fill_time > snapshots.read_at
),

-- At one time, ledger rows sort before a reading, since the reading counts rows at or before read_at.
points as (
    select
        account_index,
        market_id,
        event_time as at,
        0 as is_reading,
        trade_id,
        id,
        position_after,
        null::numeric as snapshot_position,
        null::timestamptz as read_at
    from {{ ref('lighter_account_ledger') }}
    where kind in ('fill', 'exit_position')

    union all

    select
        account_index,
        market_id,
        read_at,
        1,
        null,
        id,
        null,
        position,
        read_at
    from covered
),

carried as (
    select
        *,
        count(position_after) over (
            partition by account_index, market_id
            order by at, is_reading, trade_id nulls first, id
            rows between unbounded preceding and current row
        ) as moves_seen
    from points
),

compared as (
    select
        id,
        account_index,
        market_id,
        read_at,
        is_reading,
        snapshot_position,
        coalesce(
            first_value(position_after) over (
                partition by account_index, market_id, moves_seen
                order by at, is_reading, trade_id nulls first, id
            ),
            0
        ) as ledger_position
    from carried
)

select id, account_index, market_id, read_at, snapshot_position, ledger_position
from compared
where is_reading = 1
    and snapshot_position is distinct from ledger_position
