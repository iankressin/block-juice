-- One row per market and wallet: every wallet that traded, split, merged, redeemed or converted in a
-- Polymarket market, with its PnL. Amounts are pUSD, open_shares outcome tokens.
-- Rules, from the plan's Decision 5 and progress R32:
--   net_cash_usdc is the sum of the ledger's usdc_delta, so it is after fees.
--   The wallet holds the sum of shares_delta, nulls as 0, over its moves of a token after its last move
--   that zeroed the position (a redemption that burns the whole balance): 0 when that move is the last,
--   and every move when none zeroed.
--   A token's mark is its payout fraction once the market resolved, else the close of its last candle.
--   position_value_usdc is the sum of shares held times mark. A token held with no mark leaves it, and
--   pnl_usdc, null; a token no longer held counts 0 with or without a mark.
--   pnl_usdc = net_cash_usdc + position_value_usdc.
--   trades counts the wallet's fills, as the maker of either order. buy_usdc and sell_usdc are before
--   fees: a buy's usdc_delta is -(usdc + fee), a sell's usdc - fee.
-- ledger and markets are read twice, so Postgres would materialize them, and a materialized CTE has no
-- statistics. On its guesses it joined every holding to every token's last close and outcome in nested
-- loops, despite the enable_nestloop pre-hook, and the build never finished. "not materialized" lets it
-- plan on the tables' own statistics.
with ledger as not materialized (
    select * from {{ ref('int_polymarket_wallet_ledger') }}
),

markets as not materialized (
    select condition_id, resolved_at, payout_fractions, history_complete
    from {{ ref('polymarket_markets') }}
),

tokens as (
    select token_id, outcome_index
    from {{ ref('int_polymarket_outcome_tokens') }}
),

last_closes as (
    select distinct on (token_id) token_id, close
    from {{ ref('polymarket_price_candles') }}
    order by token_id, minute desc
),

-- Each move of a token, with its (block, log index) and that of the wallet's last zeroing move of the
-- token.
token_moves as (
    select
        condition_id,
        wallet,
        token_id,
        shares_delta,
        array[block_number, log_index] as moved_at,
        max(case when zeroes_position then array[block_number, log_index] end)
            over (partition by condition_id, wallet, token_id) as zeroed_at
    from ledger
    where token_id is not null
),

holdings as (
    select
        condition_id,
        wallet,
        token_id,
        coalesce(sum(shares_delta) filter (where zeroed_at is null or moved_at > zeroed_at), 0) as shares_held
    from token_moves
    group by condition_id, wallet, token_id
),

valued as (
    select
        h.condition_id,
        h.wallet,
        h.shares_held,
        case
            when h.shares_held = 0 then 0
            when m.resolved_at is not null then h.shares_held * m.payout_fractions[t.outcome_index + 1]
            else h.shares_held * c.close
        end as value_usdc
    from holdings as h
    left join markets as m on m.condition_id = h.condition_id
    left join tokens as t on t.token_id = h.token_id
    left join last_closes as c on c.token_id = h.token_id
),

positions as (
    select
        condition_id,
        wallet,
        sum(shares_held) as open_shares,
        -- sum() skips nulls, so check that every token has a value first.
        case when bool_and(value_usdc is not null) then sum(value_usdc) end as position_value_usdc
    from valued
    group by condition_id, wallet
),

flows as (
    select
        condition_id,
        wallet,
        count(*) filter (where kind = 'trade') as trades,
        coalesce(sum(-usdc_delta - fee_usdc) filter (where kind = 'trade' and shares_delta > 0), 0) as buy_usdc,
        coalesce(sum(usdc_delta + fee_usdc) filter (where kind = 'trade' and shares_delta < 0), 0) as sell_usdc,
        coalesce(sum(fee_usdc), 0) as fees_usdc,
        coalesce(sum(usdc_delta), 0) as net_cash_usdc,
        min(block_timestamp) as first_activity_at,
        max(block_timestamp) as last_activity_at
    from ledger
    group by condition_id, wallet
),

participants as (
    select
        f.*,
        coalesce(p.open_shares, 0) as open_shares,
        -- A wallet with no token rows holds nothing.
        case when p.wallet is null then 0 else p.position_value_usdc end as position_value_usdc,
        m.resolved_at is not null as resolved,
        coalesce(m.history_complete, false) as history_complete
    from flows as f
    left join positions as p on p.condition_id = f.condition_id and p.wallet = f.wallet
    left join markets as m on m.condition_id = f.condition_id
)

select
    condition_id,
    wallet,
    trades,
    buy_usdc,
    sell_usdc,
    fees_usdc,
    net_cash_usdc,
    open_shares,
    position_value_usdc,
    net_cash_usdc + position_value_usdc as pnl_usdc,
    first_activity_at,
    last_activity_at,
    resolved,
    history_complete
from participants
