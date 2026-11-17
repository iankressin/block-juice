-- Lists each market of lighter_trades that has no row in lighter_markets, with its trades. Those are
-- binary options, which orderBookDetails leaves out, so their price and size stay null. It warns, since
-- Lighter sends no decimals for them (catalog/vendors/lighter/NOTES.md, Market identity).
{{ config(severity='warn') }}

select trades.market_id, count(*) as trades
from {{ ref('lighter_trades') }} as trades
where not exists (
    select 1 from {{ ref('lighter_markets') }} as markets
    where markets.market_id = trades.market_id
)
group by trades.market_id
