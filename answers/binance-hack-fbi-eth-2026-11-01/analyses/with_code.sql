-- The FBI-attributed Binance hack addresses on Ethereum left out of the "sent out" total: those with code
-- (a contract, or an EOA with an EIP-7702 delegation) at block 26294680 or at the window's last block, and
-- those whose code reads have not loaded (has_code null). Their top-level flows over the answer's window
-- are shown, but they can move ETH through internal calls too. Empty when there are none.
with flows as (
    {{ attributed_eth_flows('binance-hack-2026-10-29', 'ethereum', window_start('ethereum'), window_end('ethereum'), 26294680) }}
)

select address, has_code, code_kind, sent_out_wei, received_wei, state_block, balance_wei, nonce
from flows
where has_code is distinct from false
order by address
