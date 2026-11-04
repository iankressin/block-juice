-- A view, not the folder's ephemeral default, so the merged table shows up as its own step in Dagster.
{{ config(materialized='view') }}

select
    id,
    block_number,
    wallet,
    'native' as asset_type,
    'eth' as asset,
    balance,
    _loaded_at
from {{ ref('stg_ethereum__eth_balances') }}

union all

select
    id,
    block_number,
    wallet,
    'erc20' as asset_type,
    token as asset,
    balance,
    _loaded_at
from {{ ref('stg_ethereum__erc20_balances') }}
