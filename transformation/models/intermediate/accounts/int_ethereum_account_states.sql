-- Ethereum's account state reads in the shape account_states reads: one row per address and block, with
-- the balance, nonce and code read there. A read that has not loaded yet, such as one waiting in the dead
-- letters, leaves its column null. When a read was loaded twice, the most recent load wins.
-- code_kind is 'none' for no code, 'eip7702_delegation' for an EOA that delegates to a contract (code
-- 0xef0100 followed by a 20-byte address, EIP-7702), and 'contract' for any other code.
with reads as (
    select distinct on (block_number, kind, address) block_number, kind, address, balance, nonce, code
    from {{ ref('stg_ethereum__account_state') }}
    order by block_number, kind, address, _loaded_at desc
),

pivoted as (
    select
        address,
        block_number,
        max(balance) filter (where kind = 'balance') as balance_wei,
        max(nonce) filter (where kind = 'nonce') as nonce,
        max(code) filter (where kind = 'code') as code
    from reads
    group by address, block_number
)

select
    'ethereum' as chain,
    address,
    block_number,
    balance_wei,
    nonce,
    code,
    case
        when code is null then null
        when code = '0x' then 'none'
        when code ~ '^0xef0100[0-9a-f]{40}$' then 'eip7702_delegation'
        else 'contract'
    end as code_kind
from pivoted
