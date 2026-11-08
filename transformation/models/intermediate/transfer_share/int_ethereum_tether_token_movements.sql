-- Tether token movements on Ethereum in the shape token_movements reads, from the Transfer, Issue, Redeem
-- and DestroyedBlackFunds logs. value_base is in the token's base units, and value_tokens in whole tokens at
-- the decimals the panel declares for the token, so a token outside the panel has null decimals.
-- Rules (decision 7, rule_version 1):
--   An Issue or Redeem and its paired Transfer are one movement, as macros/transfer_share.sql says.
--   Ethereum's Issue emits no Transfer, so it is the movement itself.
--   A Transfer to or from the zero address that pairs with nothing does not change supply: at block 25504335
--   a Transfer of 65000000 to it left totalSupply() at 92062996230909656.
--   DestroyedBlackFunds' user is the from side.
--   There is no fee leg while the fee is zero; int_ethereum_tether_token_day_checks fails every day from a
--   non-zero fee or a Deprecate on.
--   Owners are the addresses, so both self flags are from = to.
with logs as (
    select
        id,
        contract as token,
        block_number,
        block_hash,
        block_timestamp,
        tx_hash,
        tx_index,
        log_index::text as position,
        event,
        -- Each event fills only its own arguments, so one of these is set.
        coalesce(from_address, blacklisted_user) as from_address,
        to_address,
        coalesce(value, amount, blacklisted_balance) as value_base
    from {{ ref('stg_ethereum__tether_token') }}
    where event in ('Transfer', 'Issue', 'Redeem', 'DestroyedBlackFunds')
),

movements as (
    {{ transfer_share_tether_movements(
        logs='logs',
        zero_address="'0x0000000000000000000000000000000000000000'",
        unpaired_zero_transfer_changes_supply='false'
    ) }}
)

select
    movements.id,
    'ethereum'::text as chain,
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
    on panel.chain = 'ethereum'
    and panel.token = movements.token
