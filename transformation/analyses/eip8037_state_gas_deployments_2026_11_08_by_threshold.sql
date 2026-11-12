-- Ethereum contract-deployment transactions in the answer's window whose EIP-8037 state gas, as a lower
-- bound, is strictly above each threshold, in gas, with their share of all deployments in the window.
-- 60M is the current mainnet block gas limit, 150M EIP-8037's reference limit and 200M the floor on
-- ethereum.org's Glamsterdam page; none is a finalized Glamsterdam setting. The other thresholds show the
-- shape of the distribution.
with deployments as (
    select state_gas
    from {{ ref('deployment_state_gas') }}
    where chain = 'ethereum'
        and {{ in_window('block_number', 'ethereum') }}
),

thresholds as (
    select threshold_gas::numeric as threshold_gas
    from unnest(array[0, 1000000, 2000000, 5000000, 10000000, 20000000, 30000000, 40000000, 60000000,
        100000000, 150000000, 200000000]) as threshold_gas
)

select
    thresholds.threshold_gas,
    count(deployments.state_gas) filter (where deployments.state_gas > thresholds.threshold_gas) as deployments_above,
    count(deployments.state_gas) as deployments,
    round(
        count(deployments.state_gas) filter (where deployments.state_gas > thresholds.threshold_gas)::numeric
        / nullif(count(deployments.state_gas), 0),
        4
    ) as share_above
from thresholds
cross join deployments
group by thresholds.threshold_gas
order by thresholds.threshold_gas
