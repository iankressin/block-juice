with classified as (
    {{ classified_transfers() }}
)

select round(100 * sum(value) filter (where category = 'exchange') / sum(value), 2) as exchange_share_pct
from classified
