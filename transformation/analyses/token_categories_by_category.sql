-- The token's transfers in its windows by category and chain: transfers, amount, and how many addresses
-- sent and received. The categories are those of macros/classified_transfers.sql.
with classified as (
    {{ classified_transfers() }}
)

select
    category,
    chain,
    count(*) as transfers,
    round(sum(value) / {{ token_unit() }}, 6) as amount,
    count(distinct from_address) as senders,
    count(distinct to_address) as recipients
from classified
group by category, chain
order by category, chain
