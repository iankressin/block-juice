-- Lists each pair of consecutive readings of a Lighter account whose change in collateral differs from the
-- sum of the account's USDC perps amounts in lighter_account_ledger between them, in (read_at 1, read_at 2].
-- collateral leaves out unrealized pnl, so the ledger expects it to move by money moves, realized pnl, fees
-- and funding (catalog/vendors/lighter/NOTES.md, Account value). The funding sign is L21's and the pnl scale
-- plan 1's P9.
-- A pair counts only when:
--   - every position in both readings has margin_mode 0: an isolated position holds margin of its own, and
--     how that shows in collateral is unproven;
--   - no ledger row of the account between them has a null amount, since its effect is unknown;
--   - the account has a fill or exit at or before the first reading and one after the second, so the loaded
--     fills and funding cover the whole span: plan 1 loads fills from daily S3 files, which lag the
--     readings by a day or more.
-- The tolerance is 0.000002 for each row summed, for fees and pnl rounded to 6 decimals, plus
-- |position| × 0.5 × 10^-8 for each funding row: value_usdc_per_unit has 8 decimals, so a funding row can
-- miss Lighter's booked amount by that much (L21). It warns, not fails: a position in a market whose fills
-- or rates are not loaded moves collateral with no ledger row.
{{ config(severity='warn') }}

with readings as (
    select
        account_index,
        read_at,
        collateral,
        lag(read_at) over (partition by account_index order by read_at) as previous_read_at,
        lag(collateral) over (partition by account_index order by read_at) as previous_collateral
    from {{ ref('lighter_account_snapshots') }}
),

isolated as (
    select distinct account_index, read_at
    from {{ ref('lighter_account_position_snapshots') }}
    where margin_mode is distinct from 0
),

pairs as (
    select readings.*
    from readings
    where readings.previous_read_at is not null
        and not exists (
            select 1
            from isolated
            where isolated.account_index = readings.account_index
                and isolated.read_at in (readings.previous_read_at, readings.read_at)
        )
        and not exists (
            select 1
            from {{ ref('lighter_account_ledger') }} as ledger
            where ledger.account_index = readings.account_index
                and ledger.amount is null
                and ledger.event_time > readings.previous_read_at
                and ledger.event_time <= readings.read_at
        )
        and exists (
            select 1
            from {{ ref('lighter_account_ledger') }} as ledger
            where ledger.account_index = readings.account_index
                and ledger.kind in ('fill', 'exit_position')
                and ledger.event_time <= readings.previous_read_at
        )
        and exists (
            select 1
            from {{ ref('lighter_account_ledger') }} as ledger
            where ledger.account_index = readings.account_index
                and ledger.kind in ('fill', 'exit_position')
                and ledger.event_time > readings.read_at
        )
),

compared as (
    select
        pairs.account_index,
        pairs.previous_read_at,
        pairs.read_at,
        pairs.collateral - pairs.previous_collateral as collateral_change,
        coalesce(sum(ledger.amount), 0) as ledger_change,
        count(ledger.id) as rows_summed,
        0.000002 * count(ledger.id)
            + coalesce(sum(abs(ledger.position_after) * 0.000000005) filter (where ledger.kind = 'funding'), 0)
            as tolerance
    from pairs
    left join {{ ref('lighter_account_ledger') }} as ledger
        on ledger.account_index = pairs.account_index
        and ledger.asset = 'USDC'
        and ledger.route = 'perps'
        and ledger.event_time > pairs.previous_read_at
        and ledger.event_time <= pairs.read_at
    group by 1, 2, 3, 4
)

select *
from compared
where abs(collateral_change - ledger_change) > tolerance
