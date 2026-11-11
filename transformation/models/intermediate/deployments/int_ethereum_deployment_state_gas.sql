-- One Ethereum transaction with at least one counted create, and the EIP-8037 state gas its creates and
-- new storage slots would cost, as a lower bound.
--
-- A create counts when neither it nor any frame above it has an error, in a successful transaction. Its
-- code_bytes are the length of the runtime code it deployed. Its account is new unless a state diff of the
-- transaction shows the address existing before it: a '*' or '-' row, which carries a prev. An address the
-- diffs do not list, created and deleted within the transaction, counts as new. Value transfers to new
-- accounts that are not contracts are left out.
--
-- new_slots are the storage slots of every address the transaction touched that go from zero, or absent,
-- to nonzero, decided by prev and next whatever the diff's kind.
--
-- state_gas = cost_per_state_byte * (120 * new_accounts + code_bytes + 64 * new_slots), with the cost per
-- state byte of EIP-8037 (https://eips.ethereum.org/EIPS/eip-8037) as in Last Call in November 2026.
-- Constructor execution, calldata, intrinsic gas, EIP-8038's execution-gas changes and EIP-7702
-- authorizations are left out.
{% set cost_per_state_byte = 1530 %}

with traces as (
    select * from {{ ref('stg_ethereum__contract_deployments') }}
),

transactions as (
    select * from {{ ref('stg_ethereum__contract_deployments_transactions') }}
),

state_diffs as (
    select * from {{ ref('stg_ethereum__contract_deployments_state_diffs') }}
),

creates as (
    select
        creates.block_number,
        creates.transaction_index,
        creates.trace_address,
        creates.create_from,
        creates.create_address,
        coalesce((length(creates.create_code) - 2) / 2, 0) as code_bytes
    from traces as creates
    inner join transactions
        on transactions.block_number = creates.block_number
        and transactions.transaction_index = creates.transaction_index
    where creates.trace_type = 'create'
        and creates.error is null
        and transactions.status = 1
        and not exists (
            select 1
            from traces as ancestors
            where ancestors.block_number = creates.block_number
                and ancestors.transaction_index = creates.transaction_index
                and cardinality(ancestors.trace_address) < cardinality(creates.trace_address)
                and creates.trace_address[1:cardinality(ancestors.trace_address)] = ancestors.trace_address
                and ancestors.error is not null
        )
),

existing_accounts as (
    select distinct block_number, transaction_index, address
    from state_diffs
    where not is_storage
        and diff_kind in ('*', '-')
),

creates_per_transaction as (
    select
        creates.block_number,
        creates.transaction_index,
        count(*) as creates,
        count(*) filter (where existing_accounts.address is null) as new_accounts,
        sum(creates.code_bytes) as code_bytes,
        array_agg(distinct creates.create_from) as deployers
    from creates
    left join existing_accounts
        on existing_accounts.block_number = creates.block_number
        and existing_accounts.transaction_index = creates.transaction_index
        and existing_accounts.address = creates.create_address
    group by creates.block_number, creates.transaction_index
),

new_slots as (
    select block_number, transaction_index, count(distinct (address, key)) as new_slots
    from state_diffs
    where is_storage
        and ltrim(substr(coalesce(prev, '0x'), 3), '0') = ''
        and ltrim(substr(coalesce(next, '0x'), 3), '0') <> ''
    group by block_number, transaction_index
)

select
    transactions.block_number,
    transactions.block_timestamp,
    transactions.transaction_index,
    transactions.hash as tx_hash,
    transactions.from_address,
    transactions.to_address,
    transactions.sighash,
    transactions.transaction_type,
    creates_per_transaction.deployers,
    creates_per_transaction.creates,
    creates_per_transaction.new_accounts,
    creates_per_transaction.code_bytes,
    coalesce(new_slots.new_slots, 0) as new_slots,
    {{ cost_per_state_byte }} * (
        120 * creates_per_transaction.new_accounts
        + creates_per_transaction.code_bytes
        + 64 * coalesce(new_slots.new_slots, 0)
    ) as state_gas,
    'eip-8037 last call, cost_per_state_byte {{ cost_per_state_byte }}' as rule_version
from creates_per_transaction
inner join transactions
    on transactions.block_number = creates_per_transaction.block_number
    and transactions.transaction_index = creates_per_transaction.transaction_index
left join new_slots
    on new_slots.block_number = creates_per_transaction.block_number
    and new_slots.transaction_index = creates_per_transaction.transaction_index
