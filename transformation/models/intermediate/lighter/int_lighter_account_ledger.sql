-- One change to a listed Lighter account's holdings. A listed account is one in stg_lighter__account_logs.
-- Each way an account's holdings change, from catalog/vendors/lighter/NOTES.md, and what this model does
-- with it:
--   Money moves (lighter_account_movements): each leg, kind as there, amount its signed_amount. Stake,
--   unstake, unlock and margin moves keep a null amount: their sign is unproven (L24 to L27).
--   Perp fills (lighter_account_fills, market_type perp): kind fill, USDC on perps, amount the realized
--   pnl less the fee and the integrator fee of the fill's role. Pnl and fees are USDC (plan 1's P9). S3
--   records pnl, the fees and the integrator fees on every fill only from 2026-03-30 (NOTES.md, S3 files,
--   L30). On older days a null may mean none or not recorded: pnl is null on every row until 2026-02-24,
--   and the integrator fees on nearly every row until 2026-03-29. So a fill before 2026-03-30 has a null
--   amount, and so has any fill with a null fee or integrator fee, rather than a fee-only or pnl-only
--   amount that looks priced. A null pnl from that day on means the fill realized none.
--   Funding (int_lighter_funding_payments): kind funding, USDC on perps, one row per hour mark, except marks
--   hidden by a gap in the loaded fills (see that model).
--   Position exits (ExitPosition and ExitPositionWithFunding entries): kind exit_position, position_after
--   0 and a null amount, since the entry carries a settlement price but no amount. The market is pubdata's
--   market_index, as in the LLP's real entries of both types (L28, L29).
-- Liquidations and deleverages need nothing more: plan 1's S3 trades hold them as fills, with trade_type
-- liquidation and deleverage. Left out: spot fills, until the asset a spot fill's fee is paid in is proven
-- (Decision 9); binary options, which have no lighter_markets row; and InternalLiquidateSpot and
-- L2UpdateAccountConfig entries, whose effect on balances is unproven.
-- position_after is the account's position in market_id after the row; for funding, the position that paid.
-- A fill or exit takes the L1 batch whose block range holds its block. cumulative_amount runs per account,
-- asset and route in event_time order, from the start of what is loaded: logs from the account-log
-- source's START_TIME, fills from the first S3 day, funding from the account's first loaded fill. Rows at
-- one time share one total, the sum up to and with that time: the transfer_out and transfer_fee legs of
-- one entry tie, and no balance ever held one without the other.
with listed as (
    select distinct account_index from {{ ref('stg_lighter__account_logs') }}
),

fills as (
    select
        fills.id,
        fills.account_index,
        fills.trade_id,
        fills.trade_time,
        fills.market_id,
        fills.position_after,
        case
            when fills.trade_time >= '2026-03-30 00:00:00+00'::timestamptz then
                coalesce(fills.realized_pnl, 0) - fills.fee_usdc
                    - case fills.role
                        when 'maker' then trades.integrator_maker_fee_usdc
                        when 'taker' then trades.integrator_taker_fee_usdc
                    end
        end as amount,
        trades.tx_hash,
        trades.block_number
    from {{ ref('lighter_account_fills') }} as fills
    inner join listed
        on listed.account_index = fills.account_index
    inner join {{ ref('lighter_markets') }} as markets
        on markets.market_id = fills.market_id
        and markets.market_type = 'perp'
    inner join {{ ref('lighter_trades') }} as trades
        on trades.trade_id = fills.trade_id
),

exits as (
    select
        logs.hash,
        logs.account_index,
        logs.log_time,
        (logs.pubdata ->> 'market_index')::integer as market_id,
        details.block_number
    from {{ ref('stg_lighter__account_logs') }} as logs
    left join {{ ref('stg_lighter__account_log_details') }} as details
        on details.hash = logs.hash
    where logs.pubdata_type in ('ExitPosition', 'ExitPositionWithFunding')
),

-- Each block's batch is the last one starting at or before it, if that batch's range reaches the block:
-- batches are contiguous. A range join would test every fill against every batch, so the batch starts
-- and the blocks are sorted together instead, and each block takes the latest start before it.
blocks as (
    select block_number from fills where block_number is not null
    union
    select block_number from exits where block_number is not null
),

starts as (
    select
        block_number,
        batch_number,
        count(batch_number) over (
            order by block_number, batch_number nulls last
            rows between unbounded preceding and current row
        ) as batches_seen
    from (
        select block_number, null::bigint as batch_number from blocks
        union all
        select first_block, batch_number from {{ ref('lighter_batches') }}
    ) as points
),

block_batches as (
    select
        holding.block_number,
        batches.batch_number,
        batches.status,
        batches.execute_tx_hash,
        batches.executed_at
    from (
        select
            block_number,
            batch_number,
            first_value(batch_number) over (
                partition by batches_seen
                order by block_number, batch_number nulls last
            ) as holding_batch_number
        from starts
    ) as holding
    inner join {{ ref('lighter_batches') }} as batches
        on batches.batch_number = holding.holding_batch_number
        and holding.block_number <= batches.last_block
    where holding.batch_number is null
),

ledger as (
    select
        'move:' || movements.id as id,
        movements.account_index,
        movements.log_time as event_time,
        movements.kind,
        movements.asset,
        movements.route,
        movements.signed_amount as amount,
        null::integer as market_id,
        null::numeric as position_after,
        null::bigint as trade_id,
        movements.hash,
        movements.block_number,
        movements.batch_number,
        movements.batch_status,
        movements.execute_tx_hash,
        movements.executed_at
    from {{ ref('lighter_account_movements') }} as movements

    union all

    select
        'fill:' || fills.id,
        fills.account_index,
        fills.trade_time,
        'fill',
        'USDC',
        'perps',
        fills.amount,
        fills.market_id,
        fills.position_after,
        fills.trade_id,
        fills.tx_hash,
        fills.block_number,
        block_batches.batch_number,
        block_batches.status,
        block_batches.execute_tx_hash,
        block_batches.executed_at
    from fills
    left join block_batches
        on block_batches.block_number = fills.block_number

    union all

    select
        'funding:' || funding.account_index || ':' || funding.market_id || ':'
            || extract(epoch from funding.funding_time)::bigint,
        funding.account_index,
        funding.funding_time,
        'funding',
        'USDC',
        'perps',
        funding.amount,
        funding.market_id,
        funding.position,
        null,
        null,
        null,
        null,
        null,
        null,
        null
    from {{ ref('int_lighter_funding_payments') }} as funding

    union all

    select
        'exit:' || exits.hash || ':' || exits.account_index,
        exits.account_index,
        exits.log_time,
        'exit_position',
        'USDC',
        'perps',
        null,
        exits.market_id,
        0,
        null,
        exits.hash,
        exits.block_number,
        block_batches.batch_number,
        block_batches.status,
        block_batches.execute_tx_hash,
        block_batches.executed_at
    from exits
    left join block_batches
        on block_batches.block_number = exits.block_number
)

select
    id,
    account_index,
    event_time,
    kind,
    asset,
    route,
    amount,
    sum(amount) over (
        partition by account_index, asset, route
        order by event_time
        range between unbounded preceding and current row
    ) as cumulative_amount,
    market_id,
    position_after,
    trade_id,
    hash,
    block_number,
    batch_number,
    batch_status,
    execute_tx_hash,
    executed_at
from ledger
