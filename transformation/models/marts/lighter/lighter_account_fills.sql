-- One fill per account and trade: the maker's and the taker's side of each trade, with the account's
-- position before and after. A side with no account (281474976710655, on market-settlement trades) has
-- no row. signed_size and positions are base units, fees and pnl USDC. They are null for a binary option.
select
    id,
    trade_id,
    trade_time,
    market_id,
    symbol,
    account_index,
    role,
    side,
    signed_size,
    price,
    notional_usdc,
    fee_ppm,
    fee_usdc,
    position_before,
    position_after,
    entry_quote_before_usdc,
    position_sign_changed,
    realized_pnl
from {{ ref('int_lighter_account_fills') }}
