-- No CTF position change books to a Polymarket contract. Those contracts split, merge and redeem for
-- users, whose own events (an adapter's, an auto-redeemer's or an exchange fill) already hold the flow,
-- so a contract in the wallet column counts that flow twice in the wallet ledger.
select changes.id, changes.wallet, contracts.role
from {{ ref('int_polygon_polymarket_ctf_position_changes') }} as changes
inner join {{ ref('polymarket_contracts') }} as contracts on contracts.address = changes.wallet
