-- One row per withdrawal from one L2 to Ethereum that a deposit from Ethereum into another L2 can have
-- paid for, per the rule in catalog/protocols/arbitrum-token-bridge/NOTES.md: the same Ethereum address
-- and token, the same amount, and the deposit at least the withdrawal chain's finality delay later
-- (6.4 days from Arbitrum, 1 day from Base, the shortest Base window). Each withdrawal and deposit is used
-- once. Within one Ethereum address, token and amount, withdrawals wait in one queue from the time they
-- are ready, on any chain, and each deposit in time order takes the oldest one waiting. A deposit that
-- takes a withdrawal from its own chain is a round trip and pairs nothing. candidates counts the
-- withdrawals that could have paid for the deposit. The pairing infers; the Ethereum side would prove it.
with withdrawals as (
    select
        *,
        block_timestamp + case chain when 'arbitrum' then interval '6.4 days' else interval '1 day' end as ready_at
    from {{ ref('bridge_transfers') }}
    where direction = 'to_ethereum'
),

deposits as (
    select * from {{ ref('bridge_transfers') }}
    where direction = 'from_ethereum'
),

-- A withdrawal joins the timeline when it is ready, a deposit when it lands.
events as (
    select ethereum_address, ethereum_token, amount, chain, id, block_number, log_index, ready_at as at,
        true as withdrawal
    from withdrawals
    union all
    select ethereum_address, ethereum_token, amount, chain, id, block_number, log_index, block_timestamp as at,
        false as withdrawal
    from deposits
),

-- Count ready withdrawals once along the timeline, rather than rescan every withdrawal for
-- each paired deposit. RANGE includes all withdrawals ready at the deposit's exact timestamp.
-- Subtract the deposit chain's count: only another chain can fund it.
counts as (
    select
        chain,
        id,
        count(*) filter (where withdrawal) over (
            partition by ethereum_address, ethereum_token, amount order by at
            range between unbounded preceding and current row
        ) - count(*) filter (where withdrawal) over (
            partition by ethereum_address, ethereum_token, amount, chain order by at
            range between unbounded preceding and current row
        ) as candidates
    from events
),

-- Withdrawals ready and deposits made so far, in queue order. A withdrawal ready at a deposit's exact
-- time comes first, so the deposit can take it. Moves in one block share a timestamp, so block_number and
-- log_index break the remaining ties on a chain; the text id would put "100:10" before "100:2".
running as (
    select
        *,
        count(*) filter (where withdrawal) over queue as ready,
        count(*) filter (where not withdrawal) over queue as deposited
    from events
    window queue as (
        partition by ethereum_address, ethereum_token, amount
        order by at, withdrawal desc, chain, block_number, log_index
        rows between unbounded preceding and current row
    )
),

-- A deposit that finds the queue empty takes nothing. The number of such deposits up to any point is the
-- largest gap so far between deposits made and withdrawals ready, or 0, which window functions compute
-- without a recursive query. A deposit is served when its own gap is no larger than that number before it,
-- and the withdrawal it takes is the one whose turn is the count of deposits served up to and including it.
deposit_turns as (
    select
        chain,
        id,
        ethereum_address,
        ethereum_token,
        amount,
        deposited - ready as gap,
        deposited - greatest(0, max(deposited - ready) over earlier) as turn,
        greatest(0, max(deposited - ready) over earlier) as unserved_before
    from running
    where not withdrawal
    window earlier as (
        partition by ethereum_address, ethereum_token, amount
        order by at, chain, block_number, log_index
        rows between unbounded preceding and 1 preceding
    )
),

withdrawal_turns as (
    select
        *,
        row_number() over (
            partition by ethereum_address, ethereum_token, amount order by ready_at, chain, block_number, log_index
        ) as turn
    from withdrawals
)

select
    w.chain as from_chain,
    w.l2_address as from_address,
    w.ethereum_address,
    d.chain as to_chain,
    d.l2_address as to_address,
    w.ethereum_token,
    w.amount,
    w.id as withdrawal_id,
    w.block_timestamp as withdrawn_at,
    w.tx_hash as withdrawal_tx_hash,
    d.id as deposit_id,
    d.block_timestamp as deposited_at,
    d.tx_hash as deposit_tx_hash,
    c.candidates
from deposit_turns as t
join deposits as d on d.chain = t.chain and d.id = t.id
join withdrawal_turns as w
    on w.ethereum_address = t.ethereum_address
    and w.ethereum_token = t.ethereum_token
    and w.amount = t.amount
    and w.turn = t.turn
join counts as c on c.chain = d.chain and c.id = d.id
where t.gap <= t.unserved_before
    -- A round trip uses up the withdrawal and the deposit but is no move between chains.
    and w.chain <> d.chain
