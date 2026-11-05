-- Each contract and every address that sent it SQD or got SQD from it in October 2026, on Arbitrum and
-- Base, most SQD first. Only transfers whose category is contract: a contract's transfers with an
-- exchange count as exchange transfers. When both sides are contracts, each shows as the other's counterparty.
{%- set windows = [
    {'chain': 'arbitrum', 'token': '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1', 'blocks': [510496864, 520129273]},
    {'chain': 'base', 'token': '0xd4554bea546efa83c1e6b389ecac40ea999b3e78', 'blocks': [52011727, 53350926]},
] %}
with classified as (
    {{ classified_transfers(windows) }}
),

legs as (
    select chain, to_address as contract, from_address as counterparty, from_kind as counterparty_kind,
        value as sqd_in, 0 as sqd_out, 1 as transfers_in, 0 as transfers_out
    from classified
    where category = 'contract' and to_kind = 'contract'

    union all

    select chain, from_address, to_address, to_kind, 0, value, 0, 1
    from classified
    where category = 'contract' and from_kind = 'contract'
)

select
    chain,
    contract,
    counterparty,
    counterparty_kind,
    round(sum(sqd_in) / 1e18, 6) as sqd_to_contract,
    round(sum(sqd_out) / 1e18, 6) as sqd_from_contract,
    sum(transfers_in) as transfers_to_contract,
    sum(transfers_out) as transfers_from_contract
from legs
group by chain, contract, counterparty, counterparty_kind
order by sum(sum(sqd_in + sqd_out)) over (partition by chain, contract) desc, contract, sum(sqd_in + sqd_out) desc, counterparty
