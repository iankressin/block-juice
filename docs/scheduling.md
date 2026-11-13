# Run pipelines together

Use `bj run daily` to build every pipeline in one Dagster run. The combined graph loads each shared
source and builds each shared model once. For example, accounts and transfers both use Ethereum
wallet transactions; their combined run shares that load and its upstream model work.

For recurring runs of the whole project, open **Automation → Schedules** and enable
`daily_schedule`, which runs at 06:00 UTC. Stop the individual pipeline schedules when switching
to it. Enabling both requests both sets of runs. All schedules initially remain stopped, and an
upgrade does not change the enabled schedules in an existing Dagster instance.

The existing eleven pipeline jobs, their schedules and their times are unchanged. Continue using
`bj run balances`, for example, or enable only the individual schedules for the pipelines you need.
These jobs still include every upstream dependency and can run independently. `bj run daily
--select <asset-key>` has the same explicit selection behavior as the other jobs.

## Bound concurrent work

Dagster ingestion workers share a warehouse-wide budget of four active processes; dbt builds share
a budget of one. PostgreSQL advisory locks enforce these limits across `bj run`, scheduled runs,
machines and Dagster instances connected to the same warehouse database. Waiting workers log once
and start when capacity is available. Locks are released after failure or disconnection as well as
success. Each waiting/active worker uses one additional warehouse connection.

Set `BJ_INGESTION_CONCURRENCY` or `BJ_DBT_CONCURRENCY` in the root `.env` to change these limits.
Values must be whole numbers from 1 to 64; an absent or empty value uses the default. Configure the
same limits in every worker and restart workers after changing them. Raising the dbt budget permits
overlapping builds; keep it at one when jobs share models.

The budgets govern orchestration. Direct `pnpm ingest` and `dbt build` commands bypass them. The RPC
proxies and each source retain their own request-rate/concurrency controls. A budget serializes
overlapping work; it does not silently skip manually requested runs or certify data as fresh.
Use the combined daily graph to eliminate duplicate work across pipelines in the same daily run.
