-- Lists each fill whose position_before differs from the previous fill's position_after, for the same
-- account and market in trade_id order. A first fill has no previous row and is skipped. It warns, not
-- fails: a change that is not a trade, such as an exit at delisting, also moves a position.
{{ config(severity='warn') }}

with chained as (
    select
        id,
        account_index,
        market_id,
        trade_id,
        position_before,
        lag(position_after) over (partition by account_index, market_id order by trade_id) as previous_position_after
    from {{ ref('lighter_account_fills') }}
)

select *
from chained
where previous_position_after is not null
    and position_before is distinct from previous_position_after
