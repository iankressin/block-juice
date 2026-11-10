-- ETH sent out over blocks 26316189 to 26323364 (2026-11-01 UTC) by the Ethereum addresses the FBI
-- attributes to the 2026-10-29 Binance hack that have no code at block 26294680 or at the window's last
-- block: the value of their successful top-level transactions plus the gas fees of every transaction they
-- sent. An address with code, or whose code reads have not loaded, is left out: it can move ETH through
-- internal calls, which top-level transactions do not show. _totals has the ETH they hold.
with flows as (
    {{ attributed_eth_flows('binance-hack-2026-10-29', 'ethereum', 26316189, 26323364, 26294680) }}
)

select sum(sent_out_wei) filter (where has_code = false) / 1e18 as sent_out_eth
from flows
