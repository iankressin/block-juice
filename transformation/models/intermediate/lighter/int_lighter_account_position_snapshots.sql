-- One position of one Lighter account in one reading. Lighter sends position unsigned and sign as 1 or
-- -1, so position here is sign times it: negative is short. A closed position stays listed with
-- position 0. total_funding_paid_out is missing on some positions and null here then. Meanings are in
-- catalog/vendors/lighter/NOTES.md, Snapshots.
select
    a.account_index || ':' || (p.value ->> 'market_id') || ':' || (extract(epoch from a.read_at) * 1000)::bigint as id,
    a.account_index,
    a.read_at,
    (p.value ->> 'market_id')::integer as market_id,
    p.value ->> 'symbol' as symbol,
    (p.value ->> 'sign')::integer * (p.value ->> 'position')::numeric as position,
    (p.value ->> 'avg_entry_price')::numeric as avg_entry_price,
    (p.value ->> 'position_value')::numeric as position_value,
    (p.value ->> 'unrealized_pnl')::numeric as unrealized_pnl,
    (p.value ->> 'realized_pnl')::numeric as realized_pnl,
    (p.value ->> 'total_funding_paid_out')::numeric as total_funding_paid_out,
    (p.value ->> 'liquidation_price')::numeric as liquidation_price,
    (p.value ->> 'margin_mode')::integer as margin_mode,
    (p.value ->> 'allocated_margin')::numeric as allocated_margin,
    (p.value ->> 'initial_margin_fraction')::numeric as initial_margin_fraction
from {{ ref('stg_lighter__accounts') }} as a
cross join lateral jsonb_array_elements(coalesce(a.positions, '[]'::jsonb)) as p (value)
