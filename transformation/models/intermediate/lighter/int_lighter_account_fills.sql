-- One Lighter fill: each trade gives its maker one row and its taker one row. A side whose account is
-- 281474976710655 (2^48 - 1, "no account", on market-settlement trades; vendor.yaml) has no row.
-- int_lighter_trades already scales positions, entry quotes and pnl, so nothing scales here.
-- A binary option has no decimals, so its size and positions are null.
with sides as (
    select
        trade_id,
        trade_time,
        market_id,
        symbol,
        price,
        size,
        notional_usdc,
        'maker' as role,
        maker_account_index as account_index,
        -- P9: the ask account sells and the bid account buys; the maker is the ask when is_maker_ask.
        case when is_maker_ask then 'sell' else 'buy' end as side,
        maker_fee_ppm as fee_ppm,
        maker_fee_usdc as fee_usdc,
        maker_position_before as position_before,
        maker_entry_quote_before_usdc as entry_quote_before_usdc,
        maker_position_sign_changed as position_sign_changed,
        case when is_maker_ask then ask_account_pnl else bid_account_pnl end as realized_pnl
    from {{ ref('int_lighter_trades') }}

    union all

    select
        trade_id,
        trade_time,
        market_id,
        symbol,
        price,
        size,
        notional_usdc,
        'taker' as role,
        taker_account_index as account_index,
        case when is_maker_ask then 'buy' else 'sell' end as side,
        taker_fee_ppm as fee_ppm,
        taker_fee_usdc as fee_usdc,
        taker_position_before as position_before,
        taker_entry_quote_before_usdc as entry_quote_before_usdc,
        taker_position_sign_changed as position_sign_changed,
        case when is_maker_ask then bid_account_pnl else ask_account_pnl end as realized_pnl
    from {{ ref('int_lighter_trades') }}
),

signed as (
    select
        *,
        case when side = 'buy' then size else -size end as signed_size
    from sides
    where account_index <> 281474976710655
)

select
    trade_id || ':' || role as id,
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
    position_before + signed_size as position_after,
    entry_quote_before_usdc,
    position_sign_changed,
    realized_pnl
from signed
