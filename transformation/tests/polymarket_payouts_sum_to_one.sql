-- Lists each resolved Polymarket market whose payout fractions do not add up to 1: one full set of a
-- market's outcomes always redeems for 1 pUSD. 1e-12 allows for rounding, as 1/3 is not exact.
select condition_id, payout_fractions
from {{ ref('polymarket_markets') }}
where resolved_at is not null
    and abs(coalesce((select sum(f) from unnest(payout_fractions) as f), 0) - 1) > 1e-12
