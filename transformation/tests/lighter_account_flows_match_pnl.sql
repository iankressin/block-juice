-- Lists each account, UTC day and flow field where the day's change in Lighter's own running total differs
-- from the sum of the account's USDC movements that day by more than 0.000001. The mapping is
-- catalog/vendors/lighter/NOTES.md, Account value (L15): the change in inflow is the sum of positive USDC
-- perps legs (deposits, route moves in, pool burns), outflow the negated sum of negative ones (withdrawals,
-- transfers out with their fee, pool mints), and spot_inflow and spot_outflow the same on the spot route.
-- A day counts only when its whole span lies in the window the account-log source loaded, from its
-- checkpoint's origin to its last read, and the 1d series has points at both midnights that bound it. A day
-- with no movements still counts and must show no change. It warns, not fails: the series may lag a run.
-- A source run on a new START_TIME writes a new checkpoint, so each account's latest one sets its window.
{{ config(severity='warn') }}

with windows as (
    select distinct on (checkpoint.value ->> 'account_index')
        (checkpoint.value ->> 'account_index')::bigint as account_index,
        to_timestamp((checkpoint.value ->> 'origin')::bigint / 1000.0) as window_start,
        to_timestamp((checkpoint.value ->> 'read_at')::bigint / 1000.0) as window_end
    from "{{ env_var('RAW_SCHEMA', 'raw') }}"."_checkpoints" as checkpoint
    where checkpoint.source_table = 'lighter_account_logs'
    order by checkpoint.value ->> 'account_index', checkpoint.updated_at desc
),

days as (
    select
        windows.account_index,
        today.point_time as day,
        today.inflow as inflow_0,
        tomorrow.inflow as inflow_1,
        today.outflow as outflow_0,
        tomorrow.outflow as outflow_1,
        today.spot_inflow as spot_inflow_0,
        tomorrow.spot_inflow as spot_inflow_1,
        today.spot_outflow as spot_outflow_0,
        tomorrow.spot_outflow as spot_outflow_1
    from windows
    inner join {{ ref('lighter_account_value_history') }} as today
        on today.account_index = windows.account_index
        and today.resolution = '1d'
    inner join {{ ref('lighter_account_value_history') }} as tomorrow
        on tomorrow.account_index = today.account_index
        and tomorrow.resolution = '1d'
        and tomorrow.point_time = today.point_time + interval '1 day'
    where today.point_time >= windows.window_start
        and tomorrow.point_time <= windows.window_end
),

moves as (
    select
        movements.account_index,
        date_trunc('day', movements.log_time at time zone 'UTC') at time zone 'UTC' as day,
        coalesce(sum(movements.signed_amount) filter (where movements.route = 'perps' and movements.signed_amount > 0), 0) as inflow,
        -coalesce(sum(movements.signed_amount) filter (where movements.route = 'perps' and movements.signed_amount < 0), 0) as outflow,
        coalesce(sum(movements.signed_amount) filter (where movements.route = 'spot' and movements.signed_amount > 0), 0) as spot_inflow,
        -coalesce(sum(movements.signed_amount) filter (where movements.route = 'spot' and movements.signed_amount < 0), 0) as spot_outflow
    from {{ ref('lighter_account_movements') }} as movements
    where movements.asset = 'USDC'
    group by 1, 2
),

compared as (
    select
        days.account_index,
        days.day,
        field.name as field,
        field.pnl_change,
        case field.name
            when 'inflow' then coalesce(moves.inflow, 0)
            when 'outflow' then coalesce(moves.outflow, 0)
            when 'spot_inflow' then coalesce(moves.spot_inflow, 0)
            when 'spot_outflow' then coalesce(moves.spot_outflow, 0)
        end as movements_sum
    from days
    left join moves
        on moves.account_index = days.account_index
        and moves.day = days.day
    cross join lateral (
        values
            ('inflow', days.inflow_1 - days.inflow_0),
            ('outflow', days.outflow_1 - days.outflow_0),
            ('spot_inflow', days.spot_inflow_1 - days.spot_inflow_0),
            ('spot_outflow', days.spot_outflow_1 - days.spot_outflow_0)
    ) as field (name, pnl_change)
)

select account_index, day, field, pnl_change, movements_sum
from compared
where abs(pnl_change - movements_sum) > 0.000001
