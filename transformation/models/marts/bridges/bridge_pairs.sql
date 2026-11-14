-- One row per withdrawal from one L2 to Ethereum that a deposit from Ethereum into another L2 can have
-- paid for, per the rule in catalog/protocols/arbitrum-token-bridge/NOTES.md: the same Ethereum address
-- and token, the same amount, and the deposit at least the withdrawal chain's finality delay later
-- (6.4 days from Arbitrum, 1 day from Base, the shortest Base window). Each withdrawal and deposit is used
-- once: within one Ethereum address, token and amount, the nth withdrawal pairs with the nth deposit, in
-- time order. candidates counts the withdrawals that could have paid for the deposit. The pairing infers;
-- the Ethereum side would prove it.
with withdrawals as (
    select
        *,
        block_timestamp + case chain when 'arbitrum' then interval '6.4 days' else interval '1 day' end as ready_at,
        row_number() over (partition by chain, ethereum_address, ethereum_token, amount order by block_timestamp, id) as n
    from {{ ref('bridge_transfers') }}
    where direction = 'to_ethereum'
),

deposits as (
    select
        *,
        row_number() over (partition by chain, ethereum_address, ethereum_token, amount order by block_timestamp, id) as n
    from {{ ref('bridge_transfers') }}
    where direction = 'from_ethereum'
),

-- Count ready withdrawals once along the timeline, rather than rescan every withdrawal for
-- each paired deposit. RANGE includes all withdrawals ready at the deposit's exact timestamp.
-- Subtract the deposit chain's count: only another chain can fund it.
events as (
    select ethereum_address, ethereum_token, amount, chain, ready_at as at,
        true as withdrawal, null::text as deposit_id
    from withdrawals
    union all
    select ethereum_address, ethereum_token, amount, chain, block_timestamp as at,
        false as withdrawal, id as deposit_id
    from deposits
),

counts as (
    select
        chain,
        deposit_id,
        count(*) filter (where withdrawal) over (
            partition by ethereum_address, ethereum_token, amount order by at
            range between unbounded preceding and current row
        ) - count(*) filter (where withdrawal) over (
            partition by ethereum_address, ethereum_token, amount, chain order by at
            range between unbounded preceding and current row
        ) as candidates
    from events
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
from withdrawals as w
join deposits as d
    on d.ethereum_address = w.ethereum_address
    and d.ethereum_token = w.ethereum_token
    and d.amount = w.amount
    and d.n = w.n
    and d.chain <> w.chain
    and d.block_timestamp >= w.ready_at
join counts as c on c.chain = d.chain and c.deposit_id = d.id
