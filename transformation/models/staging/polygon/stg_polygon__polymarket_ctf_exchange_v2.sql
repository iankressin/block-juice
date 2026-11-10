-- One OrderFilled of the polygon-polymarket-ctf-exchange-v2 source: the three CTF Exchange v2 contracts.
-- event is the catalog's key, ctf_exchange_v2.OrderFilled. Field meanings are in
-- catalog/protocols/polymarket/NOTES.md. Amounts are in base units (6 decimals); side is 0 for a buy and
-- 1 for a sell, for the maker. A fill whose taker is the exchange itself is the taker order's own fill.
with logs as (
    select
        id,
        data ->> 'event' as event,
        (data ->> 'block_number')::bigint as block_number,
        (data ->> 'timestamp')::timestamptz as block_timestamp,
        lower(data ->> 'tx_hash') as tx_hash,
        (data ->> 'log_index')::integer as log_index,
        lower(data ->> 'contract') as contract,
        data -> 'args' as args,
        _loaded_at
    from {{ source('polygon', 'polymarket_ctf_exchange_v2') }}
)

select
    id,
    event,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    contract,
    lower(args ->> 'orderHash') as order_hash,
    lower(args ->> 'maker') as maker,
    lower(args ->> 'taker') as taker,
    (args ->> 'side')::smallint as side,
    (args ->> 'tokenId')::numeric as token_id,
    (args ->> 'makerAmountFilled')::numeric as maker_amount_filled,
    (args ->> 'takerAmountFilled')::numeric as taker_amount_filled,
    (args ->> 'fee')::numeric as fee,
    lower(args ->> 'builder') as builder,
    lower(args ->> 'metadata') as metadata,
    _loaded_at
from logs
