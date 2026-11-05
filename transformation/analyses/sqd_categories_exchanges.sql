-- Each exchange and every wallet that sent it SQD or got SQD from it in October 2026, on Arbitrum and
-- Base, most SQD first. An exchange includes its inferred deposit addresses, so a wallet that paid into a
-- deposit address shows here, and moves between one exchange's own addresses do not. wallet_kind says
-- what the other side is: eoa, contract, or another exchange or its deposit address.
{%- set windows = [
    {'chain': 'arbitrum', 'token': '0x1337420ded5adb9980cfc35f8f2b054ea86f8ab1', 'blocks': [510496864, 520129273]},
    {'chain': 'base', 'token': '0xd4554bea546efa83c1e6b389ecac40ea999b3e78', 'blocks': [52011727, 53350926]},
] %}
with classified as (
    {{ classified_transfers(windows) }}
),

legs as (
    select chain, to_exchange as exchange, to_kind as exchange_side, from_address as wallet, from_kind as wallet_kind,
        from_exchange as wallet_exchange, value as sqd_in, 0 as sqd_out, 1 as transfers_in, 0 as transfers_out
    from classified
    where to_kind in ('exchange', 'deposit') and from_exchange is distinct from to_exchange

    union all

    select chain, from_exchange, from_kind, to_address, to_kind, to_exchange, 0, value, 0, 1
    from classified
    where from_kind in ('exchange', 'deposit') and to_exchange is distinct from from_exchange
)

select
    exchange,
    chain,
    wallet,
    wallet_kind,
    wallet_exchange,
    round(sum(sqd_in) / 1e18, 6) as sqd_to_exchange,
    round(sum(sqd_out) / 1e18, 6) as sqd_from_exchange,
    sum(transfers_in) as transfers_to_exchange,
    sum(transfers_out) as transfers_from_exchange,
    bool_or(exchange_side = 'deposit') as through_deposit_address
from legs
group by exchange, chain, wallet, wallet_kind, wallet_exchange
order by exchange, sum(sqd_in + sqd_out) desc, wallet
