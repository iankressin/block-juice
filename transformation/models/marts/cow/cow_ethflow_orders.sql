-- One CoW Protocol ETH Flow order placed by a wallet evm-cow-ethflow follows, on every chain it covers,
-- with the settlement that filled it when one did. Amounts in token base units; the ETH sent is in wei.
--
-- An order is settled when a GPv2Settlement Trade carries its UID in a later transaction than the
-- order's (a later block, or the same block at a higher transaction index). The executed_* columns sum
-- those Trades, and the settlement_* columns name the first. received_amount is the buy token the
-- settlement contract sent the order's receiver in those transactions, from the Transfers into followed
-- wallets, null when not settled. It is 0 when nothing came or when the receiver is not a followed
-- wallet, whose Transfers the source does not load. An order with no such Trade is
-- not settled: still open, expired, refunded or invalidated, which this mart does not tell apart.
with orders as (
    select * from {{ ref('int_ethereum_cow_ethflow_orders') }}
),

trades as (
    select * from {{ ref('int_ethereum_cow_trades') }}
),

transfers as (
    select * from {{ ref('int_ethereum_cow_wallet_transfers') }}
),

matched as (
    select
        o.chain,
        o.order_uid,
        t.tx_hash,
        t.block_number,
        t.block_timestamp,
        t.transaction_index,
        t.log_index,
        t.settlement,
        t.sell_amount,
        t.buy_amount,
        t.fee_amount
    from orders as o
    inner join trades as t
        on t.chain = o.chain
        and t.order_uid = o.order_uid
        and (t.block_number, t.transaction_index) > (o.block_number, o.transaction_index)
),

fills as (
    select
        chain,
        order_uid,
        count(*) as trades,
        sum(sell_amount) as executed_sell_amount,
        sum(buy_amount) as executed_buy_amount,
        sum(fee_amount) as executed_fee_amount
    from matched
    group by chain, order_uid
),

first_fill as (
    select distinct on (chain, order_uid)
        chain, order_uid, tx_hash, block_number, block_timestamp, settlement
    from matched
    order by chain, order_uid, block_number, transaction_index, log_index
),

received as (
    select o.chain, o.order_uid, coalesce(sum(tr.amount), 0) as received_amount
    from orders as o
    inner join (select distinct chain, order_uid, tx_hash, settlement from matched) as m
        on m.chain = o.chain and m.order_uid = o.order_uid
    left join transfers as tr
        on tr.chain = m.chain
        and tr.tx_hash = m.tx_hash
        and tr.from_address = m.settlement
        and tr.to_address = o.receiver
        and tr.token = o.buy_token
    group by o.chain, o.order_uid
)

select
    o.chain,
    o.order_uid,
    o.block_number,
    o.block_timestamp,
    o.tx_hash,
    o.owner,
    o.eth_flow,
    o.eth_value_wei,
    o.sell_token,
    o.buy_token,
    o.receiver,
    o.sell_amount,
    o.buy_amount,
    o.fee_amount,
    o.partially_fillable,
    fills.order_uid is not null as settled,
    coalesce(fills.trades, 0) as trades,
    first_fill.tx_hash as settlement_tx_hash,
    first_fill.block_number as settlement_block_number,
    first_fill.block_timestamp as settlement_block_timestamp,
    first_fill.settlement,
    fills.executed_sell_amount,
    fills.executed_buy_amount,
    fills.executed_fee_amount,
    case when fills.order_uid is not null then coalesce(received.received_amount, 0) end as received_amount
from orders as o
left join fills on fills.chain = o.chain and fills.order_uid = o.order_uid
left join first_fill on first_fill.chain = o.chain and first_fill.order_uid = o.order_uid
left join received on received.chain = o.chain and received.order_uid = o.order_uid
