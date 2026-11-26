-- The receiving wallet 0xac33748aad09cea8e50484cc0fa168dc23531b4d's native USDC inflows over the answer's
-- window by sender, before and after the first ANSEM sell (2026-11-24 08:57:09 UTC, a public read of
-- Solana), in USDC (ticket #96). sender_kind is `hop` for one of the five listed hop wallets, `relay_solver`
-- for 0xf70da97812cb96acdf810712aa562db8dfa3dbef, the sender of the direct Relay fills (Relay's API, not the
-- log, ties each fill to a Solana deposit), and `other` for the rest, such as dust from lookalike addresses.
select
    case when f.block_timestamp < timestamptz '2026-11-24 08:57:09+00' then 'before_first_sell'
        else 'after_first_sell' end as period,
    f.counterparty,
    case
        when f.counterparty in (
            '0x06ee679b907a654a9126caf511922f632f6e4b03',
            '0x0a0a6bd1c26becc4b3d94d2a695c3484d9e26072',
            '0xb8009d1da10b8fe53330cfb2cbc77f2de241f3ec',
            '0x7c612de1ed39e75400f2b659c668084761e05e20',
            '0x48411900612f3fad92b133d0bfa95225085f753e'
        ) then 'hop'
        when f.counterparty = '0xf70da97812cb96acdf810712aa562db8dfa3dbef' then 'relay_solver'
        else 'other'
    end as sender_kind,
    count(*) as inflows,
    sum(f.value) / power(10, max(t.decimals)) as usdc,
    min(f.block_timestamp) as first_at,
    max(f.block_timestamp) as last_at
from {{ ref('erc20_wallet_flows') }} as f
left join {{ ref('tokens') }} as t on t.chain = f.chain and t.token = f.token
where f.chain = 'arbitrum'
    and f.token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
    and f.wallet = '0xac33748aad09cea8e50484cc0fa168dc23531b4d'
    and f.direction = 'in'
    and {{ in_window('f.block_number', 'arbitrum') }}
group by 1, 2, 3
order by period desc, usdc desc, f.counterparty
