-- Lists each position in Lighter's account readings that differs from the position lighter_account_ledger
-- rebuilds from fills and exits: the position_after of the account's last fill or exit in that market at or
-- before read_at, or 0 when it has none. A reading counts only when the account has a fill or exit after
-- read_at, so the loaded fills cover it: plan 1 loads fills from daily S3 files, which lag the reading by a
-- day or more. position is signed in both. It warns, not fails: the ledger holds only the markets the
-- lighter-trades source loads, so an open position in another market lists here once its account is covered.
{{ config(severity='warn') }}

with covered as (
    select snapshots.*
    from {{ ref('lighter_account_position_snapshots') }} as snapshots
    where exists (
        select 1
        from {{ ref('lighter_account_ledger') }} as ledger
        where ledger.account_index = snapshots.account_index
            and ledger.kind in ('fill', 'exit_position')
            and ledger.event_time > snapshots.read_at
    )
)

select
    covered.id,
    covered.account_index,
    covered.market_id,
    covered.read_at,
    covered.position as snapshot_position,
    coalesce(last_row.position_after, 0) as ledger_position
from covered
left join lateral (
    select ledger.position_after
    from {{ ref('lighter_account_ledger') }} as ledger
    where ledger.account_index = covered.account_index
        and ledger.market_id = covered.market_id
        and ledger.kind in ('fill', 'exit_position')
        and ledger.event_time <= covered.read_at
    order by ledger.event_time desc, ledger.trade_id desc nulls last, ledger.id desc
    limit 1
) as last_row on true
where covered.position is distinct from coalesce(last_row.position_after, 0)
