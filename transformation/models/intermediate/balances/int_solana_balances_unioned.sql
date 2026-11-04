-- A view, not the folder's ephemeral default, so the merged table shows up as its own step in Dagster.
{{ config(materialized='view') }}

select
    id,
    slot,
    wallet,
    'native' as asset_type,
    'sol' as asset,
    balance,
    _loaded_at
from {{ ref('stg_solana__sol_balances') }}

union all

select
    id,
    slot,
    wallet,
    'spl' as asset_type,
    mint as asset,
    balance,
    _loaded_at
from {{ ref('stg_solana__spl_balances') }}
