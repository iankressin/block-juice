-- Each ETH outflow of the wallet Lookonchain links to the Ethereum Foundation over the answer's window:
-- when, where to, its class, and for a sale the CoW settlement that filled it and the stablecoin the wallet
-- received, in the token's base units.
select
    block_number,
    block_timestamp,
    tx_hash,
    to_address,
    outflow_class,
    venue,
    eth,
    order_uid,
    settlement_tx_hash,
    settlement_block_number,
    buy_symbol,
    buy_token,
    received_amount as received_base_units
from {{ ref('wallet_eth_outflows') }}
where chain = 'ethereum'
    and from_address = '0x5cbc6299fab3320e7758ac97fd4ca45e5b722059'
    and {{ in_window('block_number', 'ethereum') }}
order by block_number, transaction_index
