-- One HyperCore fill as the hypercore-fills source loaded it: one user's side of one trade, for the users
-- and coins in its addresses.json. The two sides of a trade share tid. side is B for a bid (a buy) or A
-- for an ask (a sell). fee is what the user paid in fee_token; a negative fee is a rebate paid to the
-- user. px, sz and fee are decimals, not base units. Field meanings are in catalog/protocols/hypercore/NOTES.md.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    (data -> 'fill' ->> 'fillIndex')::integer as fill_index,
    lower(data -> 'fill' ->> 'user') as user_address,
    data -> 'fill' ->> 'coin' as coin,
    (data -> 'fill' ->> 'px')::numeric as px,
    (data -> 'fill' ->> 'sz')::numeric as sz,
    data -> 'fill' ->> 'side' as side,
    to_timestamp((data -> 'fill' ->> 'time')::bigint / 1000.0) as fill_time,
    (data -> 'fill' ->> 'startPosition')::numeric as start_position,
    data -> 'fill' ->> 'dir' as dir,
    (data -> 'fill' ->> 'closedPnl')::numeric as closed_pnl,
    data -> 'fill' ->> 'hash' as tx_hash,
    (data -> 'fill' ->> 'oid')::bigint as oid,
    (data -> 'fill' ->> 'crossed')::boolean as crossed,
    (data -> 'fill' ->> 'fee')::numeric as fee,
    (data -> 'fill' ->> 'builderFee')::numeric as builder_fee,
    (data -> 'fill' ->> 'tid')::bigint as tid,
    data -> 'fill' ->> 'cloid' as cloid,
    data -> 'fill' ->> 'feeToken' as fee_token,
    lower(data -> 'fill' ->> 'builder') as builder,
    (data -> 'fill' ->> 'twapId')::bigint as twap_id,
    _loaded_at
from {{ source('hypercore', 'fills') }}
