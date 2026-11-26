-- Native USDC inflows, outflows and net over the answer's window for each of the six listed Arbitrum
-- wallets (ticket #96), in USDC and the net in base units. A wallet with no flow still has a row of zeros.
with listed (wallet) as (
    values
        ('0xac33748aad09cea8e50484cc0fa168dc23531b4d'),
        ('0x06ee679b907a654a9126caf511922f632f6e4b03'),
        ('0x0a0a6bd1c26becc4b3d94d2a695c3484d9e26072'),
        ('0xb8009d1da10b8fe53330cfb2cbc77f2de241f3ec'),
        ('0x7c612de1ed39e75400f2b659c668084761e05e20'),
        ('0x48411900612f3fad92b133d0bfa95225085f753e')
),

usdc as (
    select decimals
    from {{ ref('tokens') }}
    where chain = 'arbitrum' and token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
),

flows as (
    select wallet, direction, value
    from {{ ref('erc20_wallet_flows') }}
    where chain = 'arbitrum'
        and token = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
        and {{ in_window('block_number', 'arbitrum') }}
),

totals as (
    select
        l.wallet,
        count(*) filter (where f.direction = 'in') as inflows,
        coalesce(sum(f.value) filter (where f.direction = 'in'), 0) as in_base_units,
        count(*) filter (where f.direction = 'out') as outflows,
        coalesce(sum(f.value) filter (where f.direction = 'out'), 0) as out_base_units
    from listed as l
    left join flows as f on f.wallet = l.wallet
    group by l.wallet
)

select
    t.wallet,
    t.inflows,
    t.in_base_units / power(10, u.decimals) as usdc_in,
    t.outflows,
    t.out_base_units / power(10, u.decimals) as usdc_out,
    (t.in_base_units - t.out_base_units) / power(10, u.decimals) as usdc_net,
    t.in_base_units - t.out_base_units as net_base_units
from totals as t
left join usdc as u on true
order by usdc_in desc, t.wallet
