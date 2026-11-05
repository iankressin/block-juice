-- The share of the SQD moved on Arbitrum and Base in October 2026 that went to or came from an exchange
-- or one of its deposit addresses, in percent. sqd_categories_by_category has every category.
{%- set windows = [
    {'chain': 'arbitrum', 'token': '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1', 'blocks': [510496864, 520129273]},
    {'chain': 'base', 'token': '0xd4554bea546efa83c1e6b389ecac40ea999b3e78', 'blocks': [52011727, 53350926]},
] %}
with classified as (
    {{ classified_transfers(windows) }}
)

select round(100 * sum(value) filter (where category = 'exchange') / sum(value), 2) as exchange_share_pct
from classified
