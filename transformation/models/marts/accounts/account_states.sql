-- One row per address and block at which an account-state source read it, on every chain it covers:
-- the native balance in wei, the nonce, the code, and code_kind ('none', 'eip7702_delegation' or
-- 'contract'). A read that has not loaded is null. Each chain's intermediate model brings its rows in
-- this shape, so a new chain adds one branch.
select chain, address, block_number, balance_wei, nonce, code, code_kind
from {{ ref('int_ethereum_account_states') }}
