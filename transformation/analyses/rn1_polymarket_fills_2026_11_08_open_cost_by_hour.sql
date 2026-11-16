-- The pUSD RN1 has tied up in markets that have not resolved yet, per UTC hour, on Polygon blocks 91743315 to
-- 97042228 (2026-08-10 00:00 to 2026-11-10 00:00 UTC). It is the cash a wallet needs to carry these
-- positions.
-- A buy ties up its cost, usdc + fee_usdc. A merge frees the pUSD it pays. When a market resolves,
-- everything still tied up in it is freed: Polymarket's auto-redeemer pays RN1 out within seconds (the exits
-- analysis). tied_high_usdc is the most tied up at any moment of the hour, tied_end_usdc the amount at its
-- end. Positions bought before the window are not in it, so its first hours read low. Fills of a token
-- Gamma lacks, and fills or merges at or after their market's resolution, are left out.
with markets as (
    select condition_id, resolved_at
    from {{ ref('polymarket_markets') }}
),

buys as (
    select f.condition_id, m.resolved_at, f.block_timestamp as at, f.usdc + f.fee_usdc as amount
    from {{ ref('polymarket_wallet_fills') }} as f
    inner join markets as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and f.side = 'buy'
        and (m.resolved_at is null or f.block_timestamp < m.resolved_at)
),

merges as (
    select c.condition_id, m.resolved_at, c.block_timestamp as at, c.usdc as amount
    from {{ ref('polymarket_position_changes') }} as c
    inner join markets as m on m.condition_id = c.condition_id
    where c.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and c.block_number between 91743315 and 97042228
        and c.kind = 'merge'
        and (m.resolved_at is null or c.block_timestamp < m.resolved_at)
),

moves as (
    select condition_id, resolved_at, at, amount as delta from buys
    union all
    select condition_id, resolved_at, at, -amount from merges
),

-- What is still tied up in each market when it resolves.
released as (
    select resolved_at as at, -sum(delta) as delta
    from moves
    where resolved_at is not null
    group by condition_id, resolved_at
),

flows as (
    select at, delta from moves
    union all
    select at, delta from released
),

running as (
    select
        at,
        delta,
        sum(delta) over (order by at, delta desc rows unbounded preceding) as tied
    from flows
    where at < '2026-11-10 00:00:00+00'
)

select
    date_trunc('hour', at at time zone 'UTC') as hour,
    round(max(tied), 6) as tied_high_usdc,
    round((array_agg(tied order by at desc, delta))[1], 6) as tied_end_usdc
from running
group by 1
order by 1
