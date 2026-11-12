-- One log of evm-cow-ethflow, as Portal returned it with its ABI-decoded arguments: an ETH Flow
-- OrderPlacement with a followed wallet as sender, an ERC-20 Transfer into a followed wallet, or a
-- GPv2Settlement Trade in a transaction with such a Transfer. Each event's arguments are cast into the
-- columns named for it; the others are null. Amounts in token base units, addresses lowercased.
select
    id,
    (data ->> 'block_number')::bigint as block_number,
    data ->> 'block_hash' as block_hash,
    (data ->> 'timestamp')::timestamptz as block_timestamp,
    lower(data ->> 'tx_hash') as tx_hash,
    (data ->> 'transaction_index')::integer as transaction_index,
    (data ->> 'log_index')::integer as log_index,
    lower(data ->> 'contract') as contract,
    data ->> 'event' as event,
    -- OrderPlacement: the sender and the GPv2 order it placed.
    lower(data -> 'args' ->> 'sender') as order_sender,
    lower(data -> 'args' -> 'order' ->> 'sellToken') as order_sell_token,
    lower(data -> 'args' -> 'order' ->> 'buyToken') as order_buy_token,
    lower(data -> 'args' -> 'order' ->> 'receiver') as order_receiver,
    (data -> 'args' -> 'order' ->> 'sellAmount')::numeric as order_sell_amount,
    (data -> 'args' -> 'order' ->> 'buyAmount')::numeric as order_buy_amount,
    (data -> 'args' -> 'order' ->> 'validTo')::bigint as order_valid_to,
    (data -> 'args' -> 'order' ->> 'feeAmount')::numeric as order_fee_amount,
    data -> 'args' -> 'order' ->> 'kind' as order_kind,
    (data -> 'args' -> 'order' ->> 'partiallyFillable')::boolean as order_partially_fillable,
    data -> 'args' ->> 'data' as order_data,
    -- Trade: the order owner, what it sold and bought, and the order's UID.
    lower(data -> 'args' ->> 'owner') as trade_owner,
    lower(data -> 'args' ->> 'sellToken') as trade_sell_token,
    lower(data -> 'args' ->> 'buyToken') as trade_buy_token,
    (data -> 'args' ->> 'sellAmount')::numeric as trade_sell_amount,
    (data -> 'args' ->> 'buyAmount')::numeric as trade_buy_amount,
    (data -> 'args' ->> 'feeAmount')::numeric as trade_fee_amount,
    lower(data -> 'args' ->> 'orderUid') as trade_order_uid,
    -- Transfer: the token is the contract that emitted it.
    lower(data -> 'args' ->> 'from') as transfer_from,
    lower(data -> 'args' ->> 'to') as transfer_to,
    (data -> 'args' ->> 'value')::numeric as transfer_value,
    _loaded_at
from {{ source('ethereum', 'cow_ethflow') }}
where data ->> 'kind' = 'log'
