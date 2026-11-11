{{ config(tags=['reference']) }}
-- #42: Ethereum contract-deployment transactions whose EIP-8037 state gas is above each threshold, verified
-- on ethereum blocks 26366424 to 26369413 against an archive RPC's trace_block and trace_replayTransaction
-- [stateDiff]. The actual CTE is analyses/eip8037_state_gas_deployments_2026_11_08_by_threshold.sql.
with deployments as (
    select state_gas
    from {{ ref('deployment_state_gas') }}
    where chain = 'ethereum'
        and block_number between 26366424 and 26369413
),

thresholds as (
    select threshold_gas::numeric as threshold_gas
    from unnest(array[0, 1000000, 2000000, 5000000, 10000000, 20000000, 30000000, 40000000, 60000000,
        100000000, 150000000, 200000000]) as threshold_gas
),

actual as (
    select
        thresholds.threshold_gas,
        count(deployments.state_gas) filter (where deployments.state_gas > thresholds.threshold_gas) as deployments_above
    from thresholds
    cross join deployments
    group by thresholds.threshold_gas
)
{{ reference_mismatches(ref('reference_eip8037_state_gas_deployments_2026_11_08'), 'actual', ['threshold_gas'], 'deployments_above', 'absolute', 0) }}
