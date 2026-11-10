-- One contract-deployment transaction per row: a successful transaction with at least one create or
-- create2 that stood, on each chain loaded. state_gas is the EIP-8037 state gas its creates and new storage
-- slots would cost, in gas, as a lower bound; rule_version names the rule. new_accounts, code_bytes (bytes)
-- and new_slots are its terms. deployers lists the addresses that ran the creates. The rules are in
-- int_<chain>_deployment_state_gas.
select
    'ethereum' as chain,
    block_number,
    block_timestamp,
    transaction_index,
    tx_hash,
    from_address,
    to_address,
    sighash,
    transaction_type,
    deployers,
    creates,
    new_accounts,
    code_bytes,
    new_slots,
    state_gas,
    rule_version
from {{ ref('int_ethereum_deployment_state_gas') }}
