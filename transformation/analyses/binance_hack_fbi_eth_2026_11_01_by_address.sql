-- Each of the 608 Ethereum addresses the FBI attributes to the 2026-10-29 Binance hack: its top-level ETH
-- flows over blocks 26316189 to 26323364 (2026-11-01 UTC), and its balance, nonce and code at state_block,
-- the last block of the window. Code is also checked at block 26294680, the first block of 2026-10-29.
-- Amounts in wei, with the headline columns also in ETH. Active addresses first, then by balance.
-- macros/attributed_eth_flows.sql defines each column.
with flows as (
    {{ attributed_eth_flows('binance-hack-2026-10-29', 'ethereum', 26316189, 26323364, 26294680) }}
)

select
    address,
    active,
    has_code,
    code_kind,
    sent_txs,
    sent_failed_txs,
    sent_value_wei,
    sent_fees_wei,
    sent_out_wei,
    received_txs,
    received_wei,
    state_block,
    balance_wei,
    nonce,
    sent_out_wei / 1e18 as sent_out_eth,
    received_wei / 1e18 as received_eth,
    balance_wei / 1e18 as balance_eth
from flows
order by active desc, balance_wei desc nulls last, address
