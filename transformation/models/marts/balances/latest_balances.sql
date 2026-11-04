-- Each wallet's latest balance of each asset, on every chain, in the asset's base units.
-- block_number is the slot on Solana. Reverted ERC-20 calls (null balance) are left out.
with balances as (
    select 'ethereum' as chain, wallet, asset_type, asset, block_number, balance
    from {{ ref('int_ethereum_balances_unioned') }}

    union all

    select 'solana' as chain, wallet, asset_type, asset, slot as block_number, balance
    from {{ ref('int_solana_balances_unioned') }}
)

select distinct on (chain, wallet, asset)
    chain,
    wallet,
    asset_type,
    asset,
    block_number,
    balance
from balances
where balance is not null
order by chain, wallet, asset, block_number desc
