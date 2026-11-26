-- The MEXC-labelled wallets' daily flows of _by_day, averaged per day before and after FinCEN's 6 November
-- 2026 announcement, over the answer's window. pre is every loaded day before
-- 2026-11-06 (the ticket's pre-window is 2026-10-16 to 2026-11-05), post every loaded day from 2026-11-06,
-- whose first block is 26352079. change is post_per_day - pre_per_day, null while either period has no day.
-- A change is timing, not proof the order caused it.
with daily as (
    {{ labelled_flows_daily(
        'MEXC',
        'ethereum',
        [['eth', 'native'], ['usdt', '0xdac17f958d2ee523a2206206994597c13d831ec7'], ['usdc', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']],
        ['Binance'],
        window_start('ethereum'),
        window_end('ethereum')
    ) }}
),

periods as (
    select *, case when day >= date '2026-11-06' then 'post' else 'pre' end as period
    from daily
)

select
    token,
    counterparty,
    metric,
    count(*) filter (where period = 'pre') as pre_days,
    avg(amount) filter (where period = 'pre') as pre_per_day,
    count(*) filter (where period = 'post') as post_days,
    avg(amount) filter (where period = 'post') as post_per_day,
    avg(amount) filter (where period = 'post') - avg(amount) filter (where period = 'pre') as change
from periods
group by token, counterparty, metric
order by token, counterparty, metric
