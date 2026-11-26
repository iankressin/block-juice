-- Each ERC-20 transfer a wallet source loaded, seen from each side: an `out` row for the sender and an
-- `in` row for the receiver, with the other side as the counterparty. Value is in the token's base units.
-- The wallet sources load only transfers that touch the wallets in their addresses.json, so a wallet's
-- flows are complete only when it is listed there, from the source's START_BLOCK on. A counterparty's
-- rows hold only its transfers with listed wallets.
-- A transfer from a wallet to itself gives both an `out` and an `in` row, which net to zero.
with transfers as (
    select chain, id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value
    from {{ ref('int_arbitrum_erc20_wallet_transfers') }}
)

select
    chain, id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value,
    to_address as wallet,
    'in' as direction,
    from_address as counterparty
from transfers

union all

select
    chain, id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value,
    from_address as wallet,
    'out' as direction,
    to_address as counterparty
from transfers
