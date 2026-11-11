-- The distribution of EIP-8037 state gas, in gas and as a lower bound, over Ethereum contract-deployment
-- transactions in blocks 26366424 to 26369413 (2026-11-08 00:00 to 10:00 UTC), with the sums of its terms.
select
    count(*) as deployments,
    sum(creates) as creates,
    sum(new_accounts) as new_accounts,
    sum(code_bytes) as code_bytes,
    sum(new_slots) as new_slots,
    min(state_gas) as min_state_gas,
    percentile_disc(0.5) within group (order by state_gas) as median_state_gas,
    percentile_disc(0.9) within group (order by state_gas) as p90_state_gas,
    percentile_disc(0.99) within group (order by state_gas) as p99_state_gas,
    max(state_gas) as max_state_gas,
    count(*) filter (where transaction_type = 4) as eip7702_transactions
from {{ ref('deployment_state_gas') }}
where chain = 'ethereum'
    and block_number between 26366424 and 26369413
