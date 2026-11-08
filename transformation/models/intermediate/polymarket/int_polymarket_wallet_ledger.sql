-- One row per change to a wallet's cash or shares in one market, from every version model: each fill
-- (kind trade) and each split, merge, redemption and conversion. Shares are outcome tokens and cash is
-- pUSD or USDC.e, both in whole units, not base units.
-- Rules, from the plan's Decision 5 and progress R28:
--   Every fill books the order's maker, the taker order's own fill too: its maker is the taker. A buy
--   gains shares and pays usdc + fee_usdc; a sell gives up shares and gets usdc - fee_usdc. fee_usdc is
--   set on trade rows only.
--   A fill of a token missing from int_polymarket_outcome_tokens (Gamma) drops out, as the position
--   changes of its condition do (R25).
--   Position changes come as they are; their ids already differ from the fills' (R26). Do not parse them.
-- Columns, for whoever sums them: a cash row has token_id and shares_delta null; a position change's
-- token row has usdc_delta null; a redemption's token row may have shares_delta null and zeroes_position
-- true. Trade rows have all three.
{%- set fill_columns -%}
    id, version, block_number, block_timestamp, tx_hash, log_index, wallet, token_id, side, shares, usdc, fee_usdc
{%- endset %}
{%- set change_columns -%}
    id, version, block_number, block_timestamp, tx_hash, log_index, kind, wallet, condition_id, token_id,
    shares_delta, usdc_delta
{%- endset %}

with fills as (
    select {{ fill_columns }} from {{ ref('int_polygon_polymarket_ctf_exchange_v2_fills') }}
),

changes as (
    select {{ change_columns }}, zeroes_position from {{ ref('int_polygon_polymarket_ctf_position_changes') }}
),

tokens as (
    select token_id, condition_id
    from {{ ref('int_polymarket_outcome_tokens') }}
)

select
    f.id,
    f.version,
    f.block_number,
    f.block_timestamp,
    f.tx_hash,
    f.log_index,
    'trade' as kind,
    f.wallet,
    t.condition_id,
    f.token_id,
    case when f.side = 'buy' then f.shares else -f.shares end as shares_delta,
    case when f.side = 'buy' then -(f.usdc + f.fee_usdc) else f.usdc - f.fee_usdc end as usdc_delta,
    f.fee_usdc,
    false as zeroes_position
from fills as f
inner join tokens as t on t.token_id = f.token_id
union all
select {{ change_columns }}, null::numeric as fee_usdc, zeroes_position
from changes
