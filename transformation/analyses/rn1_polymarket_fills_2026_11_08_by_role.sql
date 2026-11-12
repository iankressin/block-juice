-- RN1's maker behaviour on Polygon in the answer's window, per
-- market kind (sports or not, from Gamma) and role: fills, the shares and pUSD (before fees), fees, the typical
-- fill size, and the share-weighted price in pUSD per share. fills_per_minute spreads the fills over the
-- minutes from RN1's first to its last fill in the window. A market Gamma lacks counts as kind unknown.
with fills as (
    select
        f.*,
        case when m.is_sports then 'sports' when m.is_sports is not null then 'other' else 'unknown' end as kind
    from {{ ref('polymarket_wallet_fills') }} as f
    left join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and {{ in_window('f.block_number', 'polygon') }}
)

select
    kind,
    role,
    side,
    count(*) as fills,
    round(100.0 * count(*) / sum(count(*)) over (), 2) as pct_of_fills,
    sum(shares) as shares,
    sum(usdc) as usdc,
    sum(fee_usdc) as fee_usdc,
    round(avg(shares), 6) as avg_fill_shares,
    percentile_cont(0.5) within group (order by shares) as median_fill_shares,
    round(avg(usdc), 6) as avg_fill_usdc,
    round(sum(usdc) / nullif(sum(shares), 0), 6) as avg_price,
    count(distinct token_id) as tokens,
    count(distinct condition_id) as markets,
    round(
        count(*) / nullif((select extract(epoch from max(block_timestamp) - min(block_timestamp)) / 60 from fills), 0), 2
    ) as fills_per_minute
from fills
group by kind, role, side
order by kind, role, side
