-- One GPv2Settlement Trade on Ethereum that evm-cow-ethflow loaded: a trade in a transaction that also
-- sent an ERC-20 Transfer into a followed wallet, so other traders' trades in the same settlement too.
-- sell_amount includes fee_amount, as GPv2Settlement emits it. Amounts in token base units.
select
    'ethereum' as chain,
    block_number,
    block_timestamp,
    transaction_index,
    tx_hash,
    log_index,
    contract as settlement,
    trade_owner as owner,
    trade_sell_token as sell_token,
    trade_buy_token as buy_token,
    trade_sell_amount as sell_amount,
    trade_buy_amount as buy_amount,
    trade_fee_amount as fee_amount,
    trade_order_uid as order_uid
from {{ ref('stg_ethereum__cow_ethflow') }}
where event = 'Trade'
