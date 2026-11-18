-- One leg of a money, pool, staking or margin move in a listed account's Lighter log, with the L1 batch
-- that settled it. An entry gives a leg for each account it moves, and a row here only for the legs of
-- the account whose log holds it, so a transfer between two listed accounts puts the sender's legs under
-- the sender and the receiver's under the receiver. The rules, from catalog/vendors/lighter/NOTES.md
-- (Account logs, Account value):
--   L1Deposit: deposit of usdc_amount USDC onto perps. V1 names no asset and no route.
--   L1DepositV2: deposit of accepted_amount of asset_index onto route_type.
--   Withdraw: withdrawal of usdc_amount USDC from perps. WithdrawV2: of amount of asset_index from
--   route_type. The account is from_account_index.
--   L2Transfer: transfer_out of usdc_amount USDC on perps by the sender, transfer_in by the receiver.
--   L2TransferV2 between two accounts: transfer_out of amount on the sender's route, a transfer_fee of
--   usdc_fee USDC on that route when above 0, and transfer_in of amount on the receiver's route. The
--   sender pays amount plus the fee: 20000's outflow rose by 1900.9 + 3 (L15).
--   L2TransferV2 from an account to itself: a route_move, -amount on the from route and +amount on the
--   to route.
--   L2MintShares: pool_mint of usdc_amount USDC from perps into the pool. BurnedShares: pool_burn of
--   shares_to_burn_usdc USDC back (L15).
--   L2StakeAssets and UnstakeAssets: stake and unstake of lit_amount LIT with the staking pool.
--   ExecutedPendingUnlock: unlock of amount of asset_symbol. L2UpdateMargin: margin_move of usdc_amount
--   USDC. Their sign and route are unproven, so signed_amount and route are null.
-- Every other type gives no row: trades, position exits and settings changes. The batch is the one whose
-- block range holds the detail's block_number. The detail's own batch_number is null when the source read
-- it before the batch formed, and a join on time can miss: L16's withdrawal, at 08:38:14.781, is timed
-- before the last block of batch 109273 (08:38:14.885945), the batch ahead of its own.
with logs as (
    select * from {{ ref('stg_lighter__account_logs') }}
),

details as (
    select * from {{ ref('stg_lighter__account_log_details') }}
),

-- Built once: the planner guesses one detail row, and with a plain CTE it rebuilt the whole batches view,
-- every batch's block list unpacked, once for each detail.
batches as materialized (
    select * from {{ ref('int_lighter_batches') }}
),

legs as (
    select
        logs.hash,
        logs.log_time,
        logs.account_index,
        logs.pubdata_type,
        logs.tx_type,
        leg.leg,
        leg.kind,
        leg.asset,
        leg.route,
        leg.amount,
        leg.direction,
        leg.counterparty_account_index,
        leg.l1_address
    from logs
    cross join lateral (
        select
            logs.pubdata ->> 'from_account_index' = logs.pubdata ->> 'to_account_index' as to_itself
    ) as transfer
    cross join lateral (
        select
            'self' as leg,
            'deposit' as kind,
            (logs.pubdata ->> 'account_index')::bigint as leg_account_index,
            'USDC' as asset,
            'perps' as route,
            (logs.pubdata ->> 'usdc_amount')::numeric as amount,
            1 as direction,
            null::bigint as counterparty_account_index,
            lower(logs.pubdata ->> 'l1_address') as l1_address
        where logs.pubdata_type = 'L1Deposit'

        union all

        select
            'self', 'deposit', (logs.pubdata ->> 'account_index')::bigint,
            logs.pubdata ->> 'asset_index', lower(logs.pubdata ->> 'route_type'),
            (logs.pubdata ->> 'accepted_amount')::numeric, 1, null, lower(logs.pubdata ->> 'l1_address')
        where logs.pubdata_type = 'L1DepositV2'

        union all

        select
            'self', 'withdrawal', (logs.pubdata ->> 'from_account_index')::bigint,
            'USDC', 'perps', (logs.pubdata ->> 'usdc_amount')::numeric, -1, null, null
        where logs.pubdata_type = 'Withdraw'

        union all

        select
            'self', 'withdrawal', (logs.pubdata ->> 'from_account_index')::bigint,
            logs.pubdata ->> 'asset_index', lower(logs.pubdata ->> 'route_type'),
            (logs.pubdata ->> 'amount')::numeric, -1, null, null
        where logs.pubdata_type = 'WithdrawV2'

        union all

        select
            'from', 'transfer_out', (logs.pubdata ->> 'from_account_index')::bigint,
            'USDC', 'perps', (logs.pubdata ->> 'usdc_amount')::numeric, -1,
            (logs.pubdata ->> 'to_account_index')::bigint, null
        where logs.pubdata_type = 'L2Transfer'

        union all

        select
            'to', 'transfer_in', (logs.pubdata ->> 'to_account_index')::bigint,
            'USDC', 'perps', (logs.pubdata ->> 'usdc_amount')::numeric, 1,
            (logs.pubdata ->> 'from_account_index')::bigint, null
        where logs.pubdata_type = 'L2Transfer'

        union all

        select
            'from', case when transfer.to_itself then 'route_move' else 'transfer_out' end,
            (logs.pubdata ->> 'from_account_index')::bigint,
            logs.pubdata ->> 'asset_index', lower(logs.pubdata ->> 'from_route_type'),
            (logs.pubdata ->> 'amount')::numeric, -1,
            case when not transfer.to_itself then (logs.pubdata ->> 'to_account_index')::bigint end, null
        where logs.pubdata_type = 'L2TransferV2'

        union all

        select
            'fee', 'transfer_fee', (logs.pubdata ->> 'from_account_index')::bigint,
            'USDC', lower(logs.pubdata ->> 'from_route_type'), (logs.pubdata ->> 'usdc_fee')::numeric, -1,
            (logs.pubdata ->> 'fee_account_index')::bigint, null
        where logs.pubdata_type = 'L2TransferV2'
            and not transfer.to_itself
            and (logs.pubdata ->> 'usdc_fee')::numeric > 0

        union all

        select
            'to', case when transfer.to_itself then 'route_move' else 'transfer_in' end,
            (logs.pubdata ->> 'to_account_index')::bigint,
            logs.pubdata ->> 'asset_index', lower(logs.pubdata ->> 'to_route_type'),
            (logs.pubdata ->> 'amount')::numeric, 1,
            case when not transfer.to_itself then (logs.pubdata ->> 'from_account_index')::bigint end, null
        where logs.pubdata_type = 'L2TransferV2'

        union all

        select
            'self', 'pool_mint', (logs.pubdata ->> 'account_index')::bigint,
            'USDC', 'perps', (logs.pubdata ->> 'usdc_amount')::numeric, -1,
            (logs.pubdata ->> 'public_pool_index')::bigint, null
        where logs.pubdata_type = 'L2MintShares'

        union all

        select
            'self', 'pool_burn', (logs.pubdata ->> 'account_index')::bigint,
            'USDC', 'perps', (logs.pubdata ->> 'shares_to_burn_usdc')::numeric, 1,
            (logs.pubdata ->> 'public_pool_index')::bigint, null
        where logs.pubdata_type = 'BurnedShares'

        union all

        select
            'self', 'stake', (logs.pubdata ->> 'account_index')::bigint,
            'LIT', null, (logs.pubdata ->> 'lit_amount')::numeric, null,
            (logs.pubdata ->> 'staking_pool_index')::bigint, null
        where logs.pubdata_type = 'L2StakeAssets'

        union all

        select
            'self', 'unstake', (logs.pubdata ->> 'account_index')::bigint,
            'LIT', null, (logs.pubdata ->> 'lit_amount')::numeric, null,
            (logs.pubdata ->> 'staking_pool_index')::bigint, null
        where logs.pubdata_type = 'UnstakeAssets'

        union all

        select
            'self', 'unlock', (logs.pubdata ->> 'account_index')::bigint,
            logs.pubdata ->> 'asset_symbol', null, (logs.pubdata ->> 'amount')::numeric, null, null, null
        where logs.pubdata_type = 'ExecutedPendingUnlock'

        union all

        select
            'self', 'margin_move', (logs.pubdata ->> 'account_index')::bigint,
            'USDC', null, (logs.pubdata ->> 'usdc_amount')::numeric, null, null, null
        where logs.pubdata_type = 'L2UpdateMargin'
    ) as leg
    where leg.leg_account_index = logs.account_index
)

select
    legs.hash || ':' || legs.account_index || ':' || legs.leg as id,
    legs.hash,
    legs.log_time,
    legs.account_index,
    legs.leg,
    legs.kind,
    legs.asset,
    legs.route,
    legs.amount,
    legs.amount * legs.direction as signed_amount,
    legs.counterparty_account_index,
    legs.l1_address,
    legs.pubdata_type,
    legs.tx_type,
    details.block_number,
    batches.batch_number,
    details.batch_number as detail_batch_number,
    batches.status as batch_status,
    coalesce(batches.is_final, false) as is_final,
    batches.commit_tx_hash,
    batches.committed_at,
    batches.verify_tx_hash,
    batches.verified_at,
    batches.execute_tx_hash,
    batches.executed_at,
    batches.final_at
from legs
left join details
    on details.hash = legs.hash
left join batches
    on details.block_number between batches.first_block and batches.last_block
