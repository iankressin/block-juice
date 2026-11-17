-- Every RN1 fill, in order, in five heavily traded two-outcome markets on Polygon blocks 91743315 to 97042228
-- (2026-08-10 00:00 to 2026-11-10 00:00 UTC), with RN1's holdings and cost after each fill. Amounts are pUSD.
-- The five, from the by_market analysis: two maker-heavy markets with pairs on either side of 1 (US Open ATP
-- Tiafoe vs Michelsen, NFL Ravens vs Cowboys), the busier of RN1's two largest counter-strike markets by spend
-- (Liquid vs Aurora), a football totals market with dear pairs (Coventry vs Newcastle O/U 3.5), and
-- RN1's largest market, bought almost all as taker (Barranquilla: Pareja vs Stefanini).
-- held_0 and held_1 count only this window's fills; cost_0 and cost_1 include fees.
with fills as (
    select
        f.*,
        m.question,
        m.game_start_time,
        m.resolved_at,
        m.payout_fractions[1] as payout_0,
        m.payout_fractions[2] as payout_1
    from {{ ref('polymarket_wallet_fills') }} as f
    inner join {{ ref('polymarket_markets') }} as m on m.condition_id = f.condition_id
    where f.wallet = '0x2005d16a84ceefa912d4e380cd32e7ff827875ea'
        and f.block_number between 91743315 and 97042228
        and f.condition_id in (
            '0x2e1e684b3312b9f06072575f01fb77237e0b94bdcfcc477a553e8685cea91b82',
            '0xca6189581f97c5b82d256a196e708e21f6b95e1a982b9928e29eb69fe7ca222e',
            '0xb3190794885f832e508d086ffa82d4b84ca1e0ada9c734550637e6fdd9bb1cff',
            '0x2b2a7f39e9cbb73214856088bd98bace012fd77a3fc2920801fe1720ad8796f4',
            '0xf4ae1e2d985191bb2249a435c3b31a4e1d7089b987b27070763226cf4c04b280'
        )
)

select
    condition_id,
    question,
    game_start_time,
    resolved_at,
    payout_0,
    payout_1,
    block_number,
    log_index,
    block_timestamp,
    role,
    side,
    outcome_index,
    outcome,
    price,
    shares,
    usdc,
    fee_usdc,
    sum(case when outcome_index = 0 then (case when side = 'buy' then shares else -shares end) else 0 end) over w
        as held_0,
    sum(case when outcome_index = 1 then (case when side = 'buy' then shares else -shares end) else 0 end) over w
        as held_1,
    sum(case when outcome_index = 0 and side = 'buy' then usdc + fee_usdc else 0 end) over w as cost_0,
    sum(case when outcome_index = 1 and side = 'buy' then usdc + fee_usdc else 0 end) over w as cost_1
from fills
window w as (partition by condition_id order by block_number, log_index rows unbounded preceding)
order by condition_id, block_number, log_index
