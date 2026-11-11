-- Wildcat V2 market deployments among Ethereum contract-deployment transactions in blocks 26366424 to
-- 26369413 (2026-11-08 00:00 to 10:00 UTC), each measured on its own, with its EIP-8037 state gas in gas.
-- A deployment is Wildcat's when it calls the WildcatHooksFactory's deployMarket (0xe7ca86e3) or
-- deployMarketAndHooks (0xad78e45a), or when the HooksFactory runs one of its creates. The HooksFactory
-- address is from Wildcat's deployments page (docs.wildcat.finance/technical-overview/contract-deployments),
-- given on ticket #42. No rows means the window holds no Wildcat deployment.
select
    tx_hash,
    block_number,
    from_address,
    to_address,
    sighash,
    creates,
    new_accounts,
    code_bytes,
    new_slots,
    state_gas,
    state_gas > 60000000 as above_60m_gas_limit
from {{ ref('deployment_state_gas') }}
where chain = 'ethereum'
    and block_number between 26366424 and 26369413
    and (
        (to_address = '0xdd7dd3b5076cf89440d05585ff56d246386207be' and sighash in ('0xe7ca86e3', '0xad78e45a'))
        or '0xdd7dd3b5076cf89440d05585ff56d246386207be' = any(deployers)
    )
order by block_number, transaction_index
