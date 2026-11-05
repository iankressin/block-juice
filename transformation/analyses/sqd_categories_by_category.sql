-- The SQD transfers of October 2026 on Arbitrum and Base by category and chain: transfers, SQD, and how
-- many addresses sent and received. The categories are those of macros/classified_transfers.sql.
{%- set windows = [
    {'chain': 'arbitrum', 'token': '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1', 'blocks': [510496864, 520129273]},
    {'chain': 'base', 'token': '0xd4554bea546efa83c1e6b389ecac40ea999b3e78', 'blocks': [52011727, 53350926]},
] %}
with classified as (
    {{ classified_transfers(windows) }}
)

select
    category,
    chain,
    count(*) as transfers,
    round(sum(value) / 1e18, 6) as sqd,
    count(distinct from_address) as senders,
    count(distinct to_address) as recipients
from classified
group by category, chain
order by category, chain
