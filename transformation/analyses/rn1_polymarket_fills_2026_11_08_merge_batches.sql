-- RN1's merges on Polygon blocks 91743315 to 97042228 (2026-08-10 00:00 to 2026-11-10 00:00 UTC), one row per
-- transaction: a batch of merges sent at once. Amounts are pUSD; a merge pays 1 pUSD per pair.
-- unresolved_markets counts the batch's markets that had not resolved when it ran; live_markets those whose
-- game had started by then (Gamma's game_start_time) and had not resolved.
with merges as (
    select
        c.*,
        m.game_start_time,
        m.resolved_at
    from {{ ref('polymarket_position_changes') }} as c
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = c.condition_id
    where c.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and c.block_number between 91743315 and 97042228
        and c.kind = 'merge'
)

select
    tx_hash,
    min(block_timestamp) as block_timestamp,
    count(*) as merges,
    sum(usdc) as usdc,
    max(usdc) as largest_usdc,
    min(usdc) as smallest_usdc,
    count(*) filter (where resolved_at is null or block_timestamp < resolved_at) as unresolved_markets,
    count(*) filter (
        where game_start_time <= block_timestamp and (resolved_at is null or block_timestamp < resolved_at)
    ) as live_markets
from merges
group by tx_hash
order by 2
