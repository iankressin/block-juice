-- The flow side of the reconciliation start_balance - outgoing - fees + incoming = end_balance + gap for
-- the wallet Lookonchain links to the Ethereum Foundation over Ethereum blocks 26380784 to 26387956
-- (2026-11-10 UTC), in ETH, from its top-level transactions: outgoing is the value of the successful ones it
-- sent, fees what every one it sent paid (reverted ones too, blob fees included), incoming the value of the
-- successful ones sent to it. Internal transfers to it, which only traces show, are not here. The balances
-- need account_states reads at blocks 26380783 and 26387956, which this build did not load.
with txs as (
    select *
    from {{ ref('wallet_transactions') }}
    where chain = 'ethereum'
        and block_number between 26380784 and 26387956
),

subject as (
    select '0x5cbc6299fab3320e7758ac97fd4ca45e5b722059'::text as address
)

select
    count(*) filter (where txs.from_address = subject.address) as sent_txs,
    coalesce(sum(txs.value_wei) filter (where txs.from_address = subject.address and txs.succeeded), 0) / 1e18
        as outgoing_eth,
    coalesce(sum(txs.fee_wei + txs.blob_fee_wei) filter (where txs.from_address = subject.address), 0) / 1e18
        as fees_eth,
    coalesce(sum(txs.value_wei) filter (where txs.to_address = subject.address and txs.succeeded), 0) / 1e18
        as incoming_eth
from txs
cross join subject
