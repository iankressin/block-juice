-- One asset balance of one Lighter account in one reading. balance is what the account holds,
-- locked_balance the part locked, and margin_balance the part counted as margin. Meanings are in
-- catalog/vendors/lighter/NOTES.md, Snapshots.
select
    a.account_index || ':' || (s.value ->> 'asset_id') || ':' || (extract(epoch from a.read_at) * 1000)::bigint as id,
    a.account_index,
    a.read_at,
    (s.value ->> 'asset_id')::integer as asset_id,
    s.value ->> 'symbol' as symbol,
    (s.value ->> 'balance')::numeric as balance,
    (s.value ->> 'locked_balance')::numeric as locked_balance,
    (s.value ->> 'margin_balance')::numeric as margin_balance,
    s.value ->> 'margin_mode' as margin_mode
from {{ ref('stg_lighter__accounts') }} as a
cross join lateral jsonb_array_elements(coalesce(a.assets, '[]'::jsonb)) as s (value)
