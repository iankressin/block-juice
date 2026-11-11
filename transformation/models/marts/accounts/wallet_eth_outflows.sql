-- One top-level native outflow on every chain wallet_transactions covers: a successful transaction with
-- value, from its sender. Amounts in wei; eth is value_wei in ETH. The fee is in wallet_transactions and
-- never part of an outflow. Each outflow gets exactly one outflow_class:
--
-- - sold: the transaction placed a CoW Protocol ETH Flow order (cow_ethflow_orders) whose receiver is
--   the sender, a later settlement filled it, the buy token is in seeds/stablecoins, and the settlement
--   sent that token to the sender. venue is 'CoW Protocol'.
-- - sent_to_exchange: to_address is an exchange address in seeds/cex_addresses (Dune's cex.addresses),
--   which names the exchange in venue.
-- - sent_out: everything else, including an ETH Flow order with no matching settlement, or one that
--   bought a token that is not a stablecoin.
--
-- The rows are complete only for wallets both wallet_transactions and evm-cow-ethflow follow: a wallet
-- whose ETH Flow orders are not loaded has every order as sent_out.
with outflows as (
    select *
    from {{ ref('wallet_transactions') }}
    where succeeded and value_wei > 0
),

sold as (
    select
        o.chain,
        o.tx_hash,
        o.owner,
        o.order_uid,
        o.settlement_tx_hash,
        o.settlement_block_number,
        o.buy_token,
        s.symbol as buy_symbol,
        o.received_amount
    from {{ ref('cow_ethflow_orders') }} as o
    inner join {{ ref('stablecoins') }} as s
        on s.chain = o.chain and s.address = o.buy_token
    where o.settled and o.receiver = o.owner and o.received_amount > 0
),

exchanges as (
    select chain, lower(address) as address, min(exchange) as exchange
    from {{ ref('cex_addresses') }}
    group by chain, lower(address)
)

select
    outflows.chain,
    outflows.block_number,
    outflows.block_timestamp,
    outflows.transaction_index,
    outflows.tx_hash,
    outflows.from_address,
    outflows.to_address,
    outflows.value_wei,
    outflows.value_wei / 1e18 as eth,
    case
        when sold.tx_hash is not null then 'sold'
        when exchanges.address is not null then 'sent_to_exchange'
        else 'sent_out'
    end as outflow_class,
    case
        when sold.tx_hash is not null then 'CoW Protocol'
        when exchanges.address is not null then exchanges.exchange
    end as venue,
    sold.order_uid,
    sold.settlement_tx_hash,
    sold.settlement_block_number,
    sold.buy_token,
    sold.buy_symbol,
    sold.received_amount
from outflows
left join sold
    on sold.chain = outflows.chain
    and sold.tx_hash = outflows.tx_hash
    and sold.owner = outflows.from_address
left join exchanges
    on exchanges.chain = outflows.chain
    and exchanges.address = outflows.to_address
