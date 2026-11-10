-- One fill per order of the CTF Exchange v2 contracts: each OrderFilled, read for its maker.
-- Rules, from catalog/protocols/polymarket/NOTES.md:
--   Q1 (rows 1, 2, 3, 10, 11): side 0 is a buy and anything else a sell, for the maker. A buy gives pUSD
--   (makerAmountFilled) for shares (takerAmountFilled); a sell gives shares for pUSD. Both are before
--   fees. fee is pUSD: a buyer pays it on top of usdc, a seller has it taken from usdc. The model keeps
--   usdc before fees and fee_usdc apart; the ledger does the cash arithmetic.
--   Q2 (rows 1, 2, 3, 10, 11, 17): the taker order has its own fill, with taker = the exchange. The
--   model keeps it, marked by is_taker_order, and it repeats the volume of the maker fills.
--   Mint and merge matches (rows 2, 3): the two orders trade the two outcomes of one condition, so each
--   fill keeps its own token_id and its own price; the two prices add up to 1.
--   Amounts are base units with 6 decimals, divided by 1e6 and kept at 6 places. Ids stay numeric: they are uint256.
with fills as (
    select
        id,
        contract,
        block_number,
        block_timestamp,
        tx_hash,
        log_index,
        order_hash,
        maker,
        taker,
        token_id,
        fee,
        side = 0 as is_buy,
        case when side = 0 then maker_amount_filled else taker_amount_filled end as usdc_base,
        case when side = 0 then taker_amount_filled else maker_amount_filled end as shares_base
    from {{ ref('stg_polygon__polymarket_ctf_exchange_v2') }}
    where event = 'ctf_exchange_v2.OrderFilled'
)

select
    id,
    'ctf_exchange_v2' as version,
    contract as exchange,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    order_hash,
    maker as wallet,
    taker as counterparty,
    taker = contract as is_taker_order,
    token_id,
    case when is_buy then 'buy' else 'sell' end as side,
    round(shares_base / 1e6, 6) as shares,
    round(usdc_base / 1e6, 6) as usdc,
    round(fee / 1e6, 6) as fee_usdc,
    usdc_base / nullif(shares_base, 0) as price
from fills
