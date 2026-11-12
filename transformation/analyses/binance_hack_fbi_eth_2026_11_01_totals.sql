-- The FBI-attributed Binance hack addresses on Ethereum, in one row: how many there are, how many were
-- active over the answer's window, how many have code or unread code, the ETH the
-- code-less ones sent out (value, fees, both) and all of them received in top-level transactions, and the
-- ETH all of them hold at state_block, the window's last block. In ETH.
with flows as (
    {{ attributed_eth_flows('binance-hack-2026-10-29', 'ethereum', window_start('ethereum'), window_end('ethereum'), 26294680) }}
)

select
    count(*) as addresses,
    count(*) filter (where active) as active_addresses,
    count(*) filter (where has_code) as addresses_with_code,
    count(*) filter (where has_code is null) as addresses_with_unread_code,
    count(*) filter (where balance_wei is null) as addresses_with_unread_balance,
    sum(sent_value_wei) filter (where has_code = false) / 1e18 as sent_value_eth,
    sum(sent_fees_wei) filter (where has_code = false) / 1e18 as sent_fees_eth,
    sum(sent_out_wei) filter (where has_code = false) / 1e18 as sent_out_eth,
    sum(received_wei) / 1e18 as received_eth,
    max(state_block) as state_block,
    sum(balance_wei) / 1e18 as held_eth
from flows
