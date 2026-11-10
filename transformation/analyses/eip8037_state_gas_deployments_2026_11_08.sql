-- The number of Ethereum contract-deployment transactions in blocks 26366424 to 26369413
-- (2026-11-08 00:00 to 10:00 UTC) whose EIP-8037 state gas, as a lower bound, would exceed a 60M block gas
-- limit. _by_threshold has the counts and shares above the 150M and 200M limits and lower thresholds,
-- _distribution the spread of state gas, and _wildcat the Wildcat V2 market deployments.
select count(*) filter (where state_gas > 60000000) as deployments_above_60m_gas_limit
from {{ ref('deployment_state_gas') }}
where chain = 'ethereum'
    and block_number between 26366424 and 26369413
