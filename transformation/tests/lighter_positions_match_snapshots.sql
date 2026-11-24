-- Lists each position in Lighter's account readings that differs from the position lighter_account_ledger
-- rebuilds from fills and exits: the position_after of the account's last fill or exit in that market at or
-- before read_at, or 0 when it has none. position is signed in both.
-- A reading counts only when the loaded fills show the account's position in that market across it: the
-- account has a fill in the market after read_at, and that fill's position_before equals the position_after
-- of its last fill there at or before read_at, or 0 with none. Each fill's position_before comes from S3,
-- so when the two differ, trades between them were not loaded, as for an account lighter-trades loads only
-- through its trades with the accounts it lists, and the position at the reading is unknown. Without a
-- later fill, the fills may not have caught up: plan 1 loads them from daily S3 files, which lag the
-- reading by a day or more. A market with no loaded fills for the account, which lighter-trades does not
-- load, never counts. An exit does not count as a later fill: exits come from the Explorer log, which is
-- current, so a later exit says nothing about whether the fills have caught up. Gaps elsewhere in the
-- chain do not matter, since each fill's position_after is S3's own position_before plus its size.
-- The chain comes from lighter_account_fills, not from the ledger, so a wrong position_after in the ledger
-- still lists here instead of hiding its readings.
-- What it cannot see: unloaded trades that net to zero between the two fills around a reading, which
-- leave the chain whole although the position moved between them.
-- Readings and fills are sorted together per account and market, forward to carry the last fill's position
-- to each reading and backward to bring the next fill's position_before to it, so the test costs a few
-- sorts, not one ledger scan per reading. It warns, not fails, since the readings come from a live API.
{{ config(severity='warn') }}

with fills as (
    select
        ledger.account_index,
        ledger.market_id,
        ledger.event_time,
        ledger.trade_id,
        ledger.id,
        ledger.position_after,
        source.position_before as chain_before,
        source.position_after as chain_after
    from {{ ref('lighter_account_ledger') }} as ledger
    inner join {{ ref('lighter_account_fills') }} as source
        on 'fill:' || source.id = ledger.id
    where ledger.kind = 'fill'
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
        chain_before,
        chain_after,
        null::numeric as snapshot_position,
        null::timestamptz as read_at
    from fills

    union all

    select
        account_index,
        market_id,
        event_time,
        0,
        null,
        id,
        position_after,
        null,
        null,
        null,
        null
    from {{ ref('lighter_account_ledger') }}
    where kind = 'exit_position'

    union all

    select
        account_index,
        market_id,
        read_at,
        1,
        null,
        id,
        null,
        null,
        null,
        position,
        read_at
    from {{ ref('lighter_account_position_snapshots') }}
),

-- moves_seen counts the fills and exits so far and fills_seen the fills so far; fills_ahead counts the
-- fills after each row. All rows that share a count share the row that set it.
counted as (
    select
        *,
        count(position_after) over forward as moves_seen,
        count(chain_after) over forward as fills_seen,
        count(chain_before) over backward as fills_ahead
    from points
    window
        forward as (
            partition by account_index, market_id
            order by at, is_reading, trade_id nulls first, id
            rows between unbounded preceding and current row
        ),
        backward as (
            partition by account_index, market_id
            order by at desc, is_reading desc, trade_id desc nulls last, id desc
            rows between unbounded preceding and current row
        )
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
        ) as ledger_position,
        coalesce(
            first_value(chain_after) over (
                partition by account_index, market_id, fills_seen
                order by at, is_reading, trade_id nulls first, id
            ),
            0
        ) as chain_position,
        first_value(chain_before) over (
            partition by account_index, market_id, fills_ahead
            order by at desc, is_reading desc, trade_id desc nulls last, id desc
        ) as next_chain_before
    from counted
)

select id, account_index, market_id, read_at, snapshot_position, ledger_position
from compared
where is_reading = 1
    and next_chain_before = chain_position
    and snapshot_position is distinct from ledger_position
