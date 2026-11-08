-- Tether token movements on TRON in the shape token_movements reads, from the Transfer, Issue, Redeem and
-- DestroyedBlackFunds logs of transactions whose result is SUCCESS. Addresses are Base58 text, kept byte for
-- byte. value_base is in the token's base units, and value_tokens in whole tokens at the decimals the panel
-- declares for the token, so a token outside the panel has null decimals.
-- Rules (decision 7, rule_version 1):
--   An Issue or Redeem and its paired Transfer are one movement, as macros/transfer_share.sql says. TRON's
--   issue emits both: at block 80864600, tx index 203, an Issue and a Transfer from the zero address
--   (T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb) of the same amount.
--   Whether a Transfer to or from the zero address that pairs with nothing changes supply is not proved on
--   TRON, so its changes_supply is null and its day fails rather than guess.
--   DestroyedBlackFunds' user is the from side.
--   There is no fee leg while the fee is zero; int_tron_tether_token_day_checks fails every day from a
--   non-zero fee or a Deprecate on.
--   Owners are the addresses, so both self flags are from = to.
with logs as (
    select
        logs.id,
        logs.contract as token,
        logs.block_number,
        logs.block_hash,
        logs.block_timestamp,
        logs.tx_hash,
        logs.tx_index,
        -- TRON's log index restarts in every transaction.
        logs.tx_index || ':' || logs.log_index as position,
        logs.event,
        -- Each event fills only its own arguments, so one of these is set.
        coalesce(logs.from_address, logs.blacklisted_user) as from_address,
        logs.to_address,
        coalesce(logs.value, logs.amount, logs.blacklisted_balance) as value_base
    from {{ ref('stg_tron__tether_token') }} as logs
    inner join {{ ref('stg_tron__tether_token_transactions') }} as transactions
        on transactions.hash = logs.tx_hash
    where logs.event in ('Transfer', 'Issue', 'Redeem', 'DestroyedBlackFunds')
        and transactions.result = 'SUCCESS'
),

movements as (
    {{ transfer_share_tether_movements(
        logs='logs',
        zero_address="'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'",
        unpaired_zero_transfer_changes_supply='null::boolean'
    ) }}
)

select
    movements.id,
    'tron'::text as chain,
    movements.token,
    movements.block_number,
    movements.block_hash,
    movements.block_timestamp,
    movements.tx_hash,
    movements.tx_index,
    movements.position,
    movements.event,
    movements.family,
    movements.changes_supply,
    movements.from_address,
    movements.to_address,
    movements.from_address as from_owner,
    movements.to_address as to_owner,
    'resolved'::text as owner_status,
    movements.value_base,
    panel.decimals,
    trim_scale(movements.value_base * power(10::numeric, -panel.decimals)) as value_tokens,
    coalesce(movements.from_address = movements.to_address, false) as account_self,
    coalesce(movements.from_address = movements.to_address, false) as owner_self
from movements
left join ({{ transfer_share_panel() }}) as panel
    on panel.chain = 'tron'
    and panel.token = movements.token
