-- The number of Ethereum contract-deployment transactions in the answer's window whose EIP-8037 state
-- gas, as a lower bound, would exceed a 60M block gas limit. _by_threshold has the counts and shares
-- above the 150M and 200M limits and lower thresholds, _distribution the spread of state gas, and
-- _wildcat the Wildcat V2 market deployments.
select count(*) filter (where state_gas > 60000000) as deployments_above_60m_gas_limit
from {{ ref('deployment_state_gas') }}
where chain = 'ethereum'
    and {{ in_window('block_number', 'ethereum') }}
