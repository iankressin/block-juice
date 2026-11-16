-- One HyperCore fill: one user's side of one trade, for the users and coins the hypercore-fills source
-- follows. The two sides of a trade are two rows that share tid. px is in the coin's quote asset per
-- coin; sz, signed_size and start_position are in coin units; fee is in fee_token; notional is in the
-- coin's quote asset, which may not be USD. signed_size is positive for a buy and negative for a sell.
select
    id,
    block_number,
    block_timestamp,
    fill_time,
    fill_index,
    tx_hash,
    tid,
    oid,
    cloid,
    twap_id,
    user_address,
    coin,
    side,
    dir,
    px,
    sz,
    signed_size,
    notional,
    is_taker,
    start_position,
    closed_pnl,
    fee,
    fee_token,
    builder,
    builder_fee
from {{ ref('int_hypercore_fills') }}
