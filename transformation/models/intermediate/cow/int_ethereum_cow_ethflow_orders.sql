-- One CoW Protocol ETH Flow order a followed wallet placed on Ethereum, from its OrderPlacement log and
-- the createOrder call that emitted it. The order's GPv2 UID is the 56 bytes the settlement keys it by:
-- the order hash createOrder returned (32), the owner, which for an ETH Flow order is the ETH Flow
-- contract (20), and the order's validTo (4). The sell token is WETH, which ETH Flow wraps at settlement;
-- the ETH the wallet sent is the createOrder call's value. Amounts in token base units.
with placements as (
    select
        *,
        row_number() over (partition by tx_hash, contract, order_sender order by log_index) as nth
    from {{ ref('stg_ethereum__cow_ethflow') }}
    where event = 'OrderPlacement'
),

calls as (
    select
        *,
        row_number() over (partition by tx_hash, to_address, from_address order by trace_address::text) as nth
    from {{ ref('stg_ethereum__cow_ethflow_traces') }}
    where error is null and output is not null
)

select
    'ethereum' as chain,
    p.block_number,
    p.block_timestamp,
    p.transaction_index,
    p.tx_hash,
    p.log_index,
    p.order_sender as owner,
    p.contract as eth_flow,
    c.output || substr(p.contract, 3) || lpad(to_hex(p.order_valid_to), 8, '0') as order_uid,
    c.value as eth_value_wei,
    p.order_sell_token as sell_token,
    p.order_buy_token as buy_token,
    p.order_receiver as receiver,
    p.order_sell_amount as sell_amount,
    p.order_buy_amount as buy_amount,
    p.order_fee_amount as fee_amount,
    p.order_partially_fillable as partially_fillable
from placements as p
left join calls as c
    on c.tx_hash = p.tx_hash
    and c.to_address = p.contract
    and c.from_address = p.order_sender
    and c.nth = p.nth
