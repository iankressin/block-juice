-- One HyperCore fill: every staging column and the three rules below, from
-- catalog/protocols/hypercore/NOTES.md.
--   signed_size is sz for side B and -sz for side A. Each fill carries its own user's side, and A on a
--   Close Long is a sell. A buy adds to the position: fill 2 buys 0.01 from startPosition 4305.693, and
--   the user's next fill starts at 4305.703. Any other side gets null, not a guessed sign, and the mart's
--   not_null test on signed_size fails on it.
--   notional is px * sz, the trade's value in the coin's quote asset. It may not be USD: HIP-3 coins
--   such as io:ANTH and xyz:SNDK may quote in another collateral, and the fills do not say which.
--   is_taker is crossed. Of a trade's two fills, the crossed one is the taker.
select
    id,
    block_number,
    block_timestamp,
    fill_index,
    user_address,
    coin,
    px,
    sz,
    side,
    fill_time,
    start_position,
    dir,
    closed_pnl,
    tx_hash,
    oid,
    crossed,
    fee,
    builder_fee,
    tid,
    cloid,
    fee_token,
    builder,
    twap_id,
    case side when 'B' then sz when 'A' then -sz end as signed_size,
    px * sz as notional,
    crossed as is_taker,
    _loaded_at
from {{ ref('stg_hypercore__fills') }}
