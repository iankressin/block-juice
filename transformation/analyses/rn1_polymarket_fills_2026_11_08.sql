-- The share of RN1's Polymarket fills that were maker-side, in percent, on Polygon blocks 91743315 to
-- 97042228 (2026-08-10 00:00 to 2026-11-10 00:00 UTC). RN1 is the wallet
-- 0x2005d16a84ceefa912d4e380cd32e7ff827875ea.
-- A fill is maker-side when RN1's order rested on the book (role maker), from the exchange's own
-- OrderFilled logs, not from the trade's direction.
select
    round(100.0 * count(*) filter (where role = 'maker') / nullif(count(*), 0), 2) as maker_fill_pct
from {{ ref('polymarket_wallet_fills') }}
where wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
    and block_number between 91743315 and 97042228
