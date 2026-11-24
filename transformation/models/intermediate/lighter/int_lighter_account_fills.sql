-- One Lighter fill: each trade gives its maker one row and its taker one row. A side whose account is
-- 281474976710655 (2^48 - 1, "no account", on market-settlement trades; vendor.yaml) has no row.
-- int_lighter_trades already scales positions, entry quotes and pnl, so nothing scales here.
-- A binary option has no decimals, so its size and positions are null.
with sides as (
    select
        t.trade_id,
        t.trade_time,
        t.market_id,
        t.symbol,
        t.price,
        t.size,
        t.notional_usdc,
        s.role,
        s.account_index,
        -- P9: the ask account sells and the bid account buys; the maker is the ask when is_maker_ask.
        case when s.is_ask then 'sell' else 'buy' end as side,
        s.fee_ppm,
        s.fee_usdc,
        s.position_before,
        s.entry_quote_before_usdc,
        s.position_sign_changed,
        case when s.is_ask then t.ask_account_pnl else t.bid_account_pnl end as realized_pnl
    from {{ ref('int_lighter_trades') }} as t
    cross join lateral (
        values
            (
                'maker', t.is_maker_ask, t.maker_account_index, t.maker_fee_ppm, t.maker_fee_usdc,
                t.maker_position_before, t.maker_entry_quote_before_usdc, t.maker_position_sign_changed
            ),
            (
                -- is not true: a null is_maker_ask makes the maker the bid, so the taker is the ask, as before.
                'taker', t.is_maker_ask is not true, t.taker_account_index, t.taker_fee_ppm, t.taker_fee_usdc,
                t.taker_position_before, t.taker_entry_quote_before_usdc, t.taker_position_sign_changed
            )
    ) as s (
        role, is_ask, account_index, fee_ppm, fee_usdc,
        position_before, entry_quote_before_usdc, position_sign_changed
    )
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
