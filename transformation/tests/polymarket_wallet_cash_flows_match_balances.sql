-- At each balance reading of a wallet and cash token after its first, the balance that
-- polymarket_wallet_cash_flows rebuilt from transfers must equal the reading. A wallet's first reading
-- is where its rows start, so it has nothing to compare; one read before the transfers' START_BLOCK
-- fails here at the next reading. macros/polymarket_cash_readings.sql picks the readings inside the blocks
-- polygon.erc20_transfers has loaded; polymarket_wallet_cash_flows_match_balances_has_readings.sql warns
-- when it finds none. A wallet whose first reading came late has its earlier transfers left out of the
-- mart, and no later reading can show that: read the first one at the block before START_BLOCK.
{{ config(tags=['coverage']) }}
with readings as (
    {{ polymarket_cash_readings() }}
)

select
    r.wallet,
    r.token,
    r.block_number,
    r.balance as read_balance,
    coalesce(last_flow.balance, r.opening_balance) as rebuilt_balance
from readings as r
left join lateral (
    select f.balance
    from {{ ref('polymarket_wallet_cash_flows') }} as f
    where f.wallet = r.wallet
        and f.token = r.token
        and f.block_number <= r.block_number
    order by f.block_number desc, f.log_index desc
    limit 1
) as last_flow on true
where r.balance <> coalesce(last_flow.balance, r.opening_balance)
