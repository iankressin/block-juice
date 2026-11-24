-- One Lighter trade in real units, with its market. Each rule cites its section of
-- catalog/vendors/lighter/NOTES.md. Scaled values multiply by 10^-n rather than divide by 10^n:
-- Postgres rounds a quotient to about 16 significant digits.
-- Each trade is scaled by its market's latest size_decimals and price_decimals. The test
-- lighter_markets_keep_their_decimals fails the build if a market's decimals ever change. Trades
-- would then need scaling by the reading in effect at trade time.
with trades as (
    select
        *,
        -- Market identity: the file's market_id is a slot Lighter reuses, and public_market_index is
        -- the API's market_id, null in every file before 2026-08-20. So a row's market is the
        -- coalesce, and every join and filter uses it, never the slot.
        coalesce(public_market_index, slot_market_id) as market_id
    from {{ ref('stg_lighter__trades') }}
)

select
    trades.trade_id,
    trades.trade_time,
    trades.block_number,
    trades.tx_hash,
    trades.trade_type,
    trades.market_id,
    trades.slot_market_id,
    markets.symbol,
    markets.market_type,
    -- Units: price is price / 10^price_decimals USDC per base unit, and size is size / 10^size_decimals
    -- base units, with the market's decimals. Binary options have no market row (Market identity), so
    -- their price and size are null; price_raw and size_raw keep the integers.
    trim_scale(trades.price_raw * power(10::numeric, -markets.price_decimals)) as price,
    trim_scale(trades.size_raw * power(10::numeric, -markets.size_decimals)) as size,
    trades.price_raw,
    trades.size_raw,
    -- Units: notional is usdc_amount / 10^6 USDC, in every market.
    trim_scale(trades.usdc_amount_raw * power(10::numeric, -6)) as notional_usdc,
    trades.is_maker_ask,
    -- P9: is_maker_ask says the ask account is the maker; then the bid is the taker, who buys.
    -- Otherwise the bid is the maker and the ask the taker, who sells.
    case when trades.is_maker_ask then trades.ask_account_id else trades.bid_account_id end as maker_account_index,
    case when trades.is_maker_ask then trades.bid_account_id else trades.ask_account_id end as taker_account_index,
    case when trades.is_maker_ask then 'buy' else 'sell' end as taker_side,
    trades.ask_account_id as ask_account_index,
    trades.bid_account_id as bid_account_index,
    -- Units: trade fees are parts per million of notional, so fee_usdc is usdc_amount × fee / 10^12.
    -- vendor.yaml gives the integrator fees the same unit.
    trades.maker_fee_raw as maker_fee_ppm,
    trades.taker_fee_raw as taker_fee_ppm,
    trim_scale(trades.usdc_amount_raw * trades.maker_fee_raw * power(10::numeric, -12)) as maker_fee_usdc,
    trim_scale(trades.usdc_amount_raw * trades.taker_fee_raw * power(10::numeric, -12)) as taker_fee_usdc,
    trim_scale(trades.usdc_amount_raw * trades.integrator_maker_fee_raw * power(10::numeric, -12)) as integrator_maker_fee_usdc,
    trim_scale(trades.usdc_amount_raw * trades.integrator_taker_fee_raw * power(10::numeric, -12)) as integrator_taker_fee_usdc,
    trades.ask_id as ask_order_index,
    trades.bid_id as bid_order_index,
    -- Units, Positions: a side's position before the trade is signed and scaled like size, and its
    -- entry quote like usdc_amount.
    trim_scale(trades.maker_position_size_before_raw * power(10::numeric, -markets.size_decimals)) as maker_position_before,
    trim_scale(trades.taker_position_size_before_raw * power(10::numeric, -markets.size_decimals)) as taker_position_before,
    trim_scale(trades.maker_entry_quote_before_raw * power(10::numeric, -6)) as maker_entry_quote_before_usdc,
    trim_scale(trades.taker_entry_quote_before_raw * power(10::numeric, -6)) as taker_entry_quote_before_usdc,
    trades.maker_position_sign_changed,
    trades.taker_position_sign_changed,
    -- Units, PnL (P9): each side's realized pnl is USDC × 10^6, null when none.
    trim_scale(trades.ask_account_pnl_raw * power(10::numeric, -6)) as ask_account_pnl,
    trim_scale(trades.bid_account_pnl_raw * power(10::numeric, -6)) as bid_account_pnl
from trades
left join {{ ref('int_lighter_markets') }} as markets
    on markets.market_id = trades.market_id
