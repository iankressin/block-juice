-- One row per order that the loaded fills name and whose signed order a loaded transaction holds: what its
-- owner posted, when it was signed, and how much of it the loaded fills took. shares are outcome tokens and
-- usdc is pUSD; limit_price is posted pUSD per posted share. side is buy or sell, for the wallet.
-- An order leaves the book when it fills in full or when its owner cancels it off chain, so an order with
-- filled_in_full false was cancelled, at a time the chain does not record, or is still open. Orders that
-- never filled are not on chain at all.
-- Rules, from catalog/protocols/polymarket/NOTES.md:
--   Q12: the order hash commits to every signed field, so every fill of one order carries the same signed
--   order; polymarket_signed_orders_agree_per_hash checks it. fills counts the loaded fills of the order
--   whose transaction is loaded.
--   Q1: a buy posts pUSD (makerAmount) for shares (takerAmount); a sell posts shares for pUSD. The fills'
--   makerAmountFilled are in the order's maker asset, so the order filled in full when they add up to its
--   makerAmount. Amounts are base units with 6 decimals, divided by 1e6 and kept at 6 places.
-- A fill that matched no order of its call has no signed order and is left out; the intermediate model's
-- not_null tests fail on it.
with fills as (
    select *
    from {{ ref('int_polygon_polymarket_ctf_exchange_v2_orders') }}
    where call_position is not null
),

per_order as (
    select
        order_hash,
        count(*) as fills,
        count(*) filter (where is_taker_order) as taker_fills,
        min(block_timestamp) as first_fill_at,
        max(block_timestamp) as last_fill_at,
        sum(maker_amount_filled) as maker_amount_filled,
        sum(taker_amount_filled) as taker_amount_filled,
        sum(fee) as fee
    from fills
    group by order_hash
),

signed as (
    select distinct on (order_hash)
        order_hash, maker, signer, signature_type, exchange, condition_id, token_id, side, maker_amount,
        taker_amount, salt, signed_at, metadata, builder
    from fills
    order by order_hash, block_number, log_index
)

select
    s.order_hash,
    s.maker as wallet,
    s.signer,
    s.signature_type,
    s.exchange,
    s.condition_id,
    s.token_id,
    case when s.side = 0 then 'buy' else 'sell' end as side,
    round(case when s.side = 0 then s.taker_amount else s.maker_amount end / 1e6, 6) as posted_shares,
    round(case when s.side = 0 then s.maker_amount else s.taker_amount end / 1e6, 6) as posted_usdc,
    (case when s.side = 0 then s.maker_amount else s.taker_amount end)
    / nullif(case when s.side = 0 then s.taker_amount else s.maker_amount end, 0) as limit_price,
    s.signed_at,
    p.first_fill_at,
    p.last_fill_at,
    p.fills,
    p.taker_fills,
    round(case when s.side = 0 then p.taker_amount_filled else p.maker_amount_filled end / 1e6, 6) as filled_shares,
    round(case when s.side = 0 then p.maker_amount_filled else p.taker_amount_filled end / 1e6, 6) as filled_usdc,
    round(p.fee / 1e6, 6) as fee_usdc,
    p.maker_amount_filled = s.maker_amount as filled_in_full,
    s.salt,
    s.metadata,
    s.builder
from signed as s
inner join per_order as p on p.order_hash = s.order_hash
