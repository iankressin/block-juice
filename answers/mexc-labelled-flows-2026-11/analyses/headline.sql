-- Net USDT flow per day, in USDT, to the 23 Ethereum wallets DefiLlama labels as MEXC on the days from
-- FinCEN's 6 November 2026 announcement on (from block 26352079), over the answer's window:
-- inflow minus outflow, leaving out transfers between two MEXC wallets. Negative means
-- more left the labelled wallets than came in. _by_period compares every token and metric before and after
-- the announcement, and _by_day has each day.
with daily as (
    {{ labelled_flows_daily(
        'MEXC',
        'ethereum',
        [['eth', 'native'], ['usdt', '0xdac17f958d2ee523a2206206994597c13d831ec7'], ['usdc', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']],
        ['Binance'],
        window_start('ethereum'),
        window_end('ethereum')
    ) }}
)

select avg(amount) as usdt_net_per_day_after_announcement
from daily
where token = 'usdt' and counterparty = 'all' and metric = 'net' and day >= date '2026-11-06'
