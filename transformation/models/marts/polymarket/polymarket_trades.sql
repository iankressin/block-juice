-- One row per maker-order fill: the tick chart of every Polymarket market. shares are outcome tokens;
-- usdc and fee_usdc are pUSD, usdc before fees; price is usdc / shares, in pUSD per share. maker_side is
-- buy or sell, for the maker.
-- The taker order's own fill repeats its makers' volume at their price, so it stays out
-- (is_taker_order); int_polymarket_wallet_ledger keeps it. A fill of a token Gamma lacks drops out, as in
-- the ledger. Each exchange version's fills model brings its rows in this shape.
{%- set columns -%}
    id, version, exchange, block_number, block_timestamp, tx_hash, log_index, wallet, counterparty,
    is_taker_order, token_id, side, shares, usdc, fee_usdc, price
{%- endset %}

with fills as (
    select {{ columns }} from {{ ref('int_polygon_polymarket_ctf_exchange_v2_fills') }}
),

tokens as (
    select token_id, condition_id, outcome
    from {{ ref('int_polymarket_outcome_tokens') }}
)

select
    f.id,
    f.version,
    f.exchange,
    f.block_number,
    f.block_timestamp,
    f.tx_hash,
    f.log_index,
    t.condition_id,
    f.token_id,
    t.outcome,
    f.wallet as maker,
    f.counterparty as taker,
    f.side as maker_side,
    f.shares,
    f.usdc,
    f.price,
    f.fee_usdc
from fills as f
inner join tokens as t on t.token_id = f.token_id
where not f.is_taker_order
