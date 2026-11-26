-- The receiving wallet 0xac33748aad09cea8e50484cc0fa168dc23531b4d's native USDC inflows minus outflows over
-- the answer's window, in USDC (ticket #96). It is the balance at the cut only if the wallet held no native
-- USDC when the window opened. _by_wallet has all six listed wallets, _by_flow each transfer.
select sum(case f.direction when 'in' then f.value else -f.value end) / power(10, max(t.decimals))
    as receiving_wallet_net_usdc
from {{ ref('erc20_wallet_flows') }} as f
left join {{ ref('tokens') }} as t on t.chain = f.chain and t.token = f.token
where f.chain = 'arbitrum'
    and f.token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
    and f.wallet = '0xac33748aad09cea8e50484cc0fa168dc23531b4d'
    and {{ in_window('f.block_number', 'arbitrum') }}
