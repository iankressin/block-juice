-- Lists each fill whose position_before differs from the previous fill's position_after, for the same
-- account and market in trade_id order. A first loaded fill has no previous row and is skipped, so trades
-- missing before it never show, and an account with one loaded fill never warns. It warns, not fails: the
-- counterparties of a filtered load miss the trades between their loaded fills. A break for a listed
-- account is the signal to look for.
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
