-- Lists each loaded log entry of a type int_lighter_account_movements handles that gives the account
-- whose log holds it no row in lighter_account_movements. Each rule reads pubdata fields by name, each
-- name proven on a real entry of its type (catalog/vendors/lighter/NOTES.md, Account logs, L15 to L27).
-- A wrong or renamed field makes the leg's account null, and the model drops the leg with no error. It
-- warns, not fails: an entry that names a listed account only as a transfer's fee account would be
-- listed too, though no leg belongs to that account.
{{ config(severity='warn') }}

select logs.id, logs.pubdata_type
from {{ ref('stg_lighter__account_logs') }} as logs
where logs.pubdata_type in (
        'L1Deposit', 'L1DepositV2', 'Withdraw', 'WithdrawV2', 'L2Transfer', 'L2TransferV2', 'L2MintShares',
        'BurnedShares', 'L2StakeAssets', 'UnstakeAssets', 'ExecutedPendingUnlock', 'L2UpdateMargin'
    )
    and not exists (
        select 1
        from {{ ref('lighter_account_movements') }} as movements
        where movements.account_index = logs.account_index
            and movements.hash = logs.hash
    )
