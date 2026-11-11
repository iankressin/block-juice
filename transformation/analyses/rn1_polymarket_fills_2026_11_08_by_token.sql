-- RN1's fills per outcome token, side and role on Polygon blocks 96972629 to 96975028 (2026-11-08 19:00 to
-- 20:00 UTC): fills, shares, pUSD paid before fees, fees, and the share-weighted price in pUSD per share.
-- tests/reference/rn1_polymarket_fills_2026_11_08_matches_reference.sql checks the shares against the
-- Polymarket Data API.
select
    f.token_id::text as token_id,
    f.side,
    f.role,
    f.condition_id,
    m.question,
    f.outcome,
    count(*) as fills,
    sum(f.shares) as shares,
    sum(f.usdc) as usdc,
    sum(f.fee_usdc) as fee_usdc,
    round(sum(f.usdc) / nullif(sum(f.shares), 0), 6) as avg_price
from {{ ref('polymarket_wallet_fills') }} as f
left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
    and f.block_number between 96972629 and 96975028
group by f.token_id, f.side, f.role, f.condition_id, m.question, f.outcome
order by shares desc, token_id, f.role
