-- One row per split, merge, redemption or conversion of a wallet in one market: the moves that change a
-- position without a trade. A split turns pUSD into a share of every outcome, a merge turns a share of
-- every outcome back into pUSD, a redemption turns a resolved market's shares into their payout, and a
-- conversion turns NO shares of a neg-risk event into YES shares of its other markets. A conversion
-- touches several markets and gives a row for each.
-- usdc is the collateral the wallet got, negative when it paid, in whole pUSD or USDC.e; 0 when the event
-- moved no cash for this market.
-- shares_delta is the wallet's change in shares of each outcome, in outcome_index order, as
-- polymarket_markets lists outcomes and payout_fractions: negative when burned, null for an outcome the
-- event does not move or names no amount for. A redemption that burns the whole balance names no amounts:
-- zeroes_position is then true, and what it burned is whatever the wallet held.
-- event is the contract event that names the wallet, as <contract>.<Event>. It says who made the move: a
-- redemption from auto_redeemer.* was made for the wallet by Polymarket's auto-redeemer, one from
-- collateral_adapter.*, ctf.* or neg_risk.* by the wallet's own call.
-- Which events count, and for which wallet, is decided in int_polygon_polymarket_ctf_position_changes. A
-- later protocol version adds its model to changes by union all.
with changes as (
    select
        version, block_number, block_timestamp, tx_hash, log_index, kind, event, wallet, condition_id, token_id,
        shares_delta, usdc_delta, zeroes_position
    from {{ ref('int_polygon_polymarket_ctf_position_changes') }}
),

tokens as (
    select token_id, condition_id, outcome_index
    from {{ ref('int_polymarket_outcome_tokens') }}
),

events as (
    select
        version,
        block_number,
        block_timestamp,
        tx_hash,
        log_index,
        kind,
        event,
        wallet,
        condition_id,
        coalesce(sum(usdc_delta), 0) as usdc,
        bool_or(zeroes_position) as zeroes_position
    from changes
    group by version, block_number, block_timestamp, tx_hash, log_index, kind, event, wallet, condition_id
),

-- Every outcome of the event's market, in order, with the event's change to it when it has one.
event_shares as (
    select
        e.block_number,
        e.log_index,
        e.condition_id,
        array_agg(c.shares_delta order by t.outcome_index) as shares_delta
    from events as e
    inner join tokens as t on t.condition_id = e.condition_id
    left join changes as c
        on c.block_number = e.block_number
        and c.log_index = e.log_index
        and c.condition_id = e.condition_id
        and c.token_id = t.token_id
    group by e.block_number, e.log_index, e.condition_id
)

select
    e.block_number || ':' || e.log_index || ':' || e.condition_id as id,
    e.version,
    e.block_number,
    e.block_timestamp,
    e.tx_hash,
    e.log_index,
    e.kind,
    e.event,
    e.wallet,
    e.condition_id,
    e.usdc,
    s.shares_delta,
    e.zeroes_position
from events as e
inner join event_shares as s
    on s.block_number = e.block_number
    and s.log_index = e.log_index
    and s.condition_id = e.condition_id
