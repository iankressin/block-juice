-- One row per fill per wallet: every OrderFilled read for its maker, the wallet whose pUSD or shares moved,
-- with the wallet's role in the match. shares are outcome tokens; usdc and fee_usdc are pUSD, usdc before
-- fees; price is usdc / shares, in pUSD per share. side is buy or sell, for the wallet.
-- Rules, from catalog/protocols/polymarket/NOTES.md:
--   Q2: a match emits one OrderFilled per maker order, whose maker is that order's owner, and one for the
--   taker order, whose maker is the taker order's owner and whose taker is the exchange. So role is taker
--   on the taker order's own fill (is_taker_order) and maker on every other fill: the exchange data says
--   which side rested, not the direction of the trade.
--   Unlike polymarket_trades, which keeps maker fills only, this mart keeps both, as
--   int_polymarket_wallet_ledger does, so a wallet's taker fills count too. counterparty is the taker
--   order's owner on a maker fill and null on a taker fill, whose counterparties are the matched makers.
--   Gamma's names come in by a left join: a fill of a token Gamma lacks keeps its row, with condition_id,
--   outcome, outcome_index and complement_token_id null.
with fills as (
    select
        id, version, exchange, block_number, block_timestamp, tx_hash, log_index, order_hash, wallet,
        counterparty, is_taker_order, token_id, side, shares, usdc, fee_usdc, price
    from {{ ref('int_polygon_polymarket_ctf_exchange_v2_fills') }}
),

tokens as (
    select token_id, condition_id, outcome_index, outcome, complement_token_id
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
    f.order_hash,
    f.wallet,
    case when f.is_taker_order then 'taker' else 'maker' end as role,
    case when not f.is_taker_order then f.counterparty end as counterparty,
    t.condition_id,
    f.token_id,
    t.outcome_index,
    t.outcome,
    t.complement_token_id,
    f.side,
    f.shares,
    f.usdc,
    f.fee_usdc,
    f.price
from fills as f
left join tokens as t on t.token_id = f.token_id
