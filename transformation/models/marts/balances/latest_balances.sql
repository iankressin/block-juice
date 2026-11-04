-- Each wallet's latest balance of each asset, on every chain, in the asset's base units.
-- Each chain's intermediate model brings its rows in this shape, so a new chain adds one branch.
with balances as (
    select chain, wallet, asset_type, asset, block_number, balance
    from {{ ref('int_ethereum_balances') }}

    union all

    select chain, wallet, asset_type, asset, block_number, balance
    from {{ ref('int_solana_balances') }}

    union all

    select chain, wallet, asset_type, asset, block_number, balance
    from {{ ref('int_bitcoin_balances') }}
)

select distinct on (chain, wallet, asset)
    chain,
    wallet,
    asset_type,
    asset,
    block_number,
    balance
from balances
order by chain, wallet, asset, block_number desc
