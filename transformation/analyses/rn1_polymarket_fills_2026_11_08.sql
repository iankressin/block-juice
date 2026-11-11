-- The share of RN1's Polymarket fills that were maker-side, in percent, on Polygon blocks 96972629 to
-- 96975028 (2026-11-08 19:00 to 20:00 UTC). RN1 is the wallet 0x2005d16a84ceefa912d4e380cd32e7ff827875ea.
-- A fill is maker-side when RN1's order rested on the book (role maker), from the exchange's own
-- OrderFilled logs, not from the trade's direction.
select
    round(100.0 * count(*) filter (where role = 'maker') / nullif(count(*), 0), 2) as maker_fill_pct
from {{ ref('polymarket_wallet_fills') }}
where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
    and block_number between 96972629 and 96975028
