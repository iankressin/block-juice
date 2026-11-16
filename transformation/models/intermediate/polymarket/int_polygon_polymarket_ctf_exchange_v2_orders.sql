-- One row per CTF Exchange v2 fill whose transaction is loaded as a matchOrders call: the fill's
-- OrderFilled, with the order its owner signed, read from the call. An OrderFilled names its order only by
-- hash; the signed order holds what was posted (makerAmount, takerAmount), who signed it, its salt and when
-- it was signed (timestamp, in milliseconds). A fill that matches no order of its call keeps its row with
-- the order's columns null, which their not_null tests catch.
{{ config(materialized='table') }}
-- Rules, from catalog/protocols/polymarket/NOTES.md:
--   Q12 (rows 44, 45): matchOrders(conditionId, takerOrder, makerOrders, takerFillAmount, makerFillAmounts,
--   takerFeeAmount, makerFeeAmounts). Maker order i fills makerFillAmounts[i] and the taker order
--   takerFillAmount, both in the order's maker asset. The exchange emits one OrderFilled per order of the
--   call, with maker = the order's maker, tokenId = its token, makerAmountFilled = its fill amount, and
--   taker = the exchange only for the taker order (Q2). So a fill and an order of one transaction match on
--   maker, token, which side they are and the amount; when two orders of one call tie on all four, the nth
--   by position in the call is the nth by log index.
--   Q1: side 0 is a buy, which gives pUSD (makerAmount) for shares (takerAmount); 1 is a sell, the reverse.
with calls as (
    select tx_hash, condition_id, args
    from {{ ref('stg_polygon__polymarket_ctf_exchange_v2_txs') }}
    where function_name = 'matchOrders'
),

-- Every order of every call, the taker order first. position is 0 for the taker order and i + 1 for maker
-- order i.
call_orders as (
    select
        tx_hash,
        condition_id,
        true as is_taker_order,
        0 as position,
        args -> 'takerOrder' as signed,
        (args ->> 'takerFillAmount')::numeric as fill_amount
    from calls
    union all
    select
        c.tx_hash,
        c.condition_id,
        false,
        m.position::integer,
        m.signed,
        (c.args -> 'makerFillAmounts' ->> (m.position - 1)::integer)::numeric
    from calls as c
    cross join lateral jsonb_array_elements(c.args -> 'makerOrders') with ordinality as m (signed, position)
),

orders as (
    select
        tx_hash,
        condition_id,
        is_taker_order,
        position,
        fill_amount,
        (signed ->> 'salt')::numeric as salt,
        lower(signed ->> 'maker') as maker,
        lower(signed ->> 'signer') as signer,
        (signed ->> 'tokenId')::numeric as token_id,
        (signed ->> 'makerAmount')::numeric as maker_amount,
        (signed ->> 'takerAmount')::numeric as taker_amount,
        (signed ->> 'side')::smallint as side,
        (signed ->> 'signatureType')::smallint as signature_type,
        to_timestamp((signed ->> 'timestamp')::numeric / 1000) as signed_at,
        lower(signed ->> 'metadata') as metadata,
        lower(signed ->> 'builder') as builder
    from call_orders
),

numbered_orders as (
    select
        *,
        row_number() over (partition by tx_hash, maker, token_id, is_taker_order, fill_amount order by position) as nth
    from orders
),

fills as (
    select
        id,
        block_number,
        block_timestamp,
        tx_hash,
        log_index,
        contract,
        order_hash,
        maker,
        token_id,
        taker = contract as is_taker_order,
        maker_amount_filled,
        taker_amount_filled,
        fee,
        row_number() over (
            partition by tx_hash, maker, token_id, taker = contract, maker_amount_filled order by log_index
        ) as nth
    from {{ ref('stg_polygon__polymarket_ctf_exchange_v2') }}
    where event = 'ctf_exchange_v2.OrderFilled'
        and tx_hash in (select tx_hash from calls)
)

select
    f.id,
    f.block_number,
    f.block_timestamp,
    f.tx_hash,
    f.log_index,
    f.contract as exchange,
    f.order_hash,
    o.condition_id,
    f.is_taker_order,
    o.position as call_position,
    f.maker,
    o.signer,
    o.signature_type,
    f.token_id,
    o.side,
    o.maker_amount,
    o.taker_amount,
    o.salt,
    o.signed_at,
    o.metadata,
    o.builder,
    f.maker_amount_filled,
    f.taker_amount_filled,
    f.fee
from fills as f
left join numbered_orders as o
    on o.tx_hash = f.tx_hash
    and o.maker = f.maker
    and o.token_id = f.token_id
    and o.is_taker_order = f.is_taker_order
    and o.fill_amount = f.maker_amount_filled
    and o.nth = f.nth
