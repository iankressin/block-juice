-- Lists each account the lighter-account-logs source walked that has no loaded log entry. The ledger and
-- funding models take a listed account to be one in stg_lighter__account_logs, so such an account, though
-- in addresses.json, gets no fill, funding or exit rows: its log holds no entry of a ledger type since
-- START_TIME, as for an account whose log since then holds only plain trades, which the walk skips. The
-- walk writes a checkpoint for each account it finishes, so the checkpoints in raw._checkpoints name the
-- accounts it read. An account later dropped from addresses.json keeps its checkpoint and lists here
-- while it has no entry. It warns, not fails: the account's next entry of a ledger type brings it in.
{{ config(severity='warn') }}

with walked as (
    select distinct (checkpoint.value ->> 'account_index')::bigint as account_index
    from "{{ env_var('RAW_SCHEMA', 'raw') }}"."_checkpoints" as checkpoint
    where checkpoint.source_table = 'lighter_account_logs'
)

select walked.account_index
from walked
where not exists (
    select 1
    from {{ ref('stg_lighter__account_logs') }} as logs
    where logs.account_index = walked.account_index
)
