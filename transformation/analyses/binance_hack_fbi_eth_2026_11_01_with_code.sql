-- The FBI-attributed Binance hack addresses on Ethereum left out of the "sent out" total: those with code
-- (a contract, or an EOA with an EIP-7702 delegation) at block 26294680 or at the window's last block, and
-- those whose code reads have not loaded (has_code null). Their top-level flows over blocks 26316189 to
-- 26323364 are shown, but they can move ETH through internal calls too. Empty when there are none.
with flows as (
    {{ attributed_eth_flows('binance-hack-2026-10-29', 'ethereum', 26316189, 26323364, 26294680) }}
)

select address, has_code, code_kind, sent_out_wei, received_wei, state_block, balance_wei, nonce
from flows
where has_code is distinct from false
order by address
