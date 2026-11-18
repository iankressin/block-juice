-- One position of one Lighter account in one reading. position is signed: negative is short. A closed
-- position stays listed with position 0. total_funding_paid_out is null where Lighter leaves it out.
select
    id,
    account_index,
    read_at,
    market_id,
    symbol,
    position,
    avg_entry_price,
    position_value,
    unrealized_pnl,
    realized_pnl,
    total_funding_paid_out,
    liquidation_price,
    margin_mode,
    allocated_margin,
    initial_margin_fraction
from {{ ref('int_lighter_account_position_snapshots') }}
