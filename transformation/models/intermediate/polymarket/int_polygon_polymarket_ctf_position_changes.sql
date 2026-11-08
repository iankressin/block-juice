-- One row per change to a wallet's cash or position from a CTF-era split, merge, redemption or
-- conversion. Rules, from catalog/protocols/polymarket/NOTES.md:
--   One user action emits up to three events (Traps): ConditionalTokens', the NegRiskAdapter's and an
--   adapter's. Only the one that names a wallet outside polymarket_contracts counts (Q4, Q5): a ctf.* or
--   neg_risk.* event whose stakeholder or redeemer is a user (rows 6, 8), and every collateral_adapter.*
--   (initiator, rows 4, 5) and auto_redeemer.* event (from, row 7). The rest repeat those events or the
--   exchange fills (row 2).
--   ctf.* events count only on USDC.e or wrapped collateral, the seed's collateral rows, and at the top
--   level (Q4). Index set 1 << i is outcome i (Q6); an index set of several outcomes maps to no token.
--   Each event gives a cash row and a row per token. A split pays amount for amount of each token, a
--   merge the reverse. A redemption pays payout and burns amounts[i] of outcome i where the event names
--   amounts; otherwise shares_delta is null. ConditionalTokens, the adapters and the auto-redeemers burn
--   the whole balance (Redemptions), so their redemptions zero the position; the NegRiskAdapter burns the
--   amounts it names.
--   A conversion (Q7) burns amount NO of each question whose bit is set in indexSet (k of them) and pays
--   amountOut YES of every other question of the market and (k - 1) x amountOut cash, split evenly over the
--   k NO conditions (plan Decision 5). amountOut is the adapter event's, or amount - amount x feeBips /
--   10000 with feeBips from MarketPrepared, 0 when the market was prepared before the window. A market's
--   questions come from QuestionPrepared and from Gamma; question i's id ends in byte i.
--   A condition missing from int_polymarket_outcome_tokens (Gamma) drops out, cash too.
--   Amounts are base units with 6 decimals, divided by 1e6 and kept at 6 places.
-- Columns, for whoever sums them: a token row has usdc_delta null. A cash row has token_id and
-- shares_delta null and zeroes_position false. Ids are <block>:<logIndex>:<token_id> and
-- <block>:<logIndex>:cash, but a conversion's k cash rows are <block>:<logIndex>:cash:<condition_id>.
with logs as (
    select *
    from {{ ref('stg_polygon__polymarket_ctf') }}
),

contracts as (
    select address, role
    from {{ ref('polymarket_contracts') }}
),

tokens as (
    select token_id, condition_id, outcome_index
    from {{ ref('int_polymarket_outcome_tokens') }}
),

-- The event of each action that names the user, with its kind.
actions as (
    select
        id,
        event,
        block_number,
        block_timestamp,
        tx_hash,
        log_index,
        case
            when event like 'collateral_adapter.%' then initiator
            when event like 'auto_redeemer.%' then from_address
            else stakeholder
        end as wallet,
        case
            when event in ('ctf.PositionSplit', 'neg_risk.PositionSplit', 'collateral_adapter.PositionSplit') then 'split'
            when event in ('ctf.PositionsMerge', 'neg_risk.PositionsMerge', 'collateral_adapter.PositionsMerged') then 'merge'
            when event in ('neg_risk.PositionsConverted', 'collateral_adapter.PositionsConverted') then 'convert'
            else 'redeem'
        end as kind,
        condition_id,
        index_sets,
        amount,
        amount_out,
        amounts,
        payout,
        neg_risk_market_id,
        index_set
    from logs
    where
        -- ConditionalTokens called by a user, on Polymarket's collateral, at the top level.
        (
            event in ('ctf.PositionSplit', 'ctf.PositionsMerge', 'ctf.PayoutRedemption')
            and stakeholder not in (select address from contracts where role <> 'collateral')
            and collateral_token in (select address from contracts where role = 'collateral')
            and parent_collection_id = '0x' || repeat('0', 64)
        )
        -- The NegRiskAdapter called by a user.
        or (
            event in ('neg_risk.PositionSplit', 'neg_risk.PositionsMerge', 'neg_risk.PayoutRedemption', 'neg_risk.PositionsConverted')
            and stakeholder not in (select address from contracts where role <> 'collateral')
        )
        -- pUSD's collateral adapters and the auto-redeemers, which act only for users.
        or event in (
            'collateral_adapter.PositionSplit', 'collateral_adapter.PositionsMerged',
            'collateral_adapter.PositionsRedeemed', 'collateral_adapter.PositionsConverted',
            'auto_redeemer.BinaryRedemption', 'auto_redeemer.NegRiskRedemption'
        )
),

-- Splits, merges and redemptions: the tokens of one condition. Only ctf.* events name index sets.
condition_tokens as (
    select
        a.*,
        t.token_id,
        case a.kind
            when 'split' then a.amount
            when 'merge' then -a.amount
            else -a.amounts[t.outcome_index + 1]
        end as shares_base
    from actions as a
    inner join tokens as t
        on t.condition_id = a.condition_id
        and (a.index_sets is null or power(2::numeric, t.outcome_index) = any(a.index_sets))
    where a.kind <> 'convert'
),

condition_cash as (
    select
        a.*,
        case a.kind
            when 'split' then -a.amount
            when 'merge' then a.amount
            else a.payout
        end as usdc_base
    from actions as a
    where a.kind <> 'convert'
        and exists (select 1 from tokens as t where t.condition_id = a.condition_id)
),

-- Conversions: the market's questions, each with its condition.
questions as (
    select q.neg_risk_market_id, q.question_index::integer as question_index, c.condition_id
    from logs as q
    inner join logs as c
        on c.event = 'ctf.ConditionPreparation'
        and c.question_id = q.question_id
        and c.oracle in (select address from contracts where role = 'neg_risk_adapter')
    where q.event = 'neg_risk.QuestionPrepared'
    union
    select neg_risk_market_id, ('x' || right(question_id, 2))::bit(8)::integer, condition_id
    from {{ ref('stg_polymarket__markets') }}
    where neg_risk_market_id is not null
        and question_id is not null
        and condition_id is not null
),

conversions as (
    select
        a.*,
        coalesce(a.amount_out, a.amount - div(a.amount * coalesce(m.fee_bips, 0), 10000)) as amount_out_base,
        (
            select count(*)
            from generate_series(0, 255) as b(i)
            where mod(div(a.index_set, power(2::numeric, b.i)), 2) = 1
        ) as burned_count
    from actions as a
    left join logs as m
        on m.event = 'neg_risk.MarketPrepared'
        and m.neg_risk_market_id = a.neg_risk_market_id
    where a.kind = 'convert'
),

-- Each question's leg: its NO token burned when its bit is set, else its YES token paid.
conversion_legs as (
    select
        c.*,
        q.condition_id as question_condition_id,
        t.token_id,
        t.outcome_index = 1 as burned
    from conversions as c
    inner join questions as q on q.neg_risk_market_id = c.neg_risk_market_id
    inner join tokens as t
        on t.condition_id = q.condition_id
        and t.outcome_index = mod(div(c.index_set, power(2::numeric, q.question_index)), 2)
),

changes as (
    select id || ':' || token_id as id, block_number, block_timestamp, tx_hash, log_index, kind, wallet,
        condition_id, token_id, shares_base, null::numeric as usdc_base,
        kind = 'redeem' and event <> 'neg_risk.PayoutRedemption' as zeroes_position
    from condition_tokens
    union all
    select id || ':cash', block_number, block_timestamp, tx_hash, log_index, kind, wallet,
        condition_id, null, null, usdc_base, false
    from condition_cash
    union all
    select id || ':' || token_id, block_number, block_timestamp, tx_hash, log_index, kind, wallet,
        question_condition_id, token_id, case when burned then -amount else amount_out_base end, null, false
    from conversion_legs
    union all
    select id || ':cash:' || question_condition_id, block_number, block_timestamp, tx_hash, log_index, kind, wallet,
        question_condition_id, null, null, (burned_count - 1) * amount_out_base / burned_count, false
    from conversion_legs
    where burned
)

select
    id,
    'ctf' as version,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    kind,
    wallet,
    condition_id,
    token_id,
    round(shares_base / 1e6, 6) as shares_delta,
    round(usdc_base / 1e6, 6) as usdc_delta,
    zeroes_position
from changes
