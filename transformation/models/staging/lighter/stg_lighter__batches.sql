-- One Lighter L1 batch, as the lighter-batches source loaded the Explorer's reply. batch_details is
-- null before batch 29654 and on a batch not yet committed, so its hashes are null there; a hash not
-- sent yet is null too. blocks lists {block_number, updated_at, total_transactions} and
-- status_changes {hash, updated_at, batch_status}, kept as jsonb for int_lighter_batches. Meanings are
-- in catalog/vendors/lighter/NOTES.md.
select
    id,
    (data ->> 'batch_number')::bigint as batch_number,
    (data ->> 'updated_at')::timestamptz as updated_at,
    data -> 'batch_details' ->> 'commit_tx_hash' as commit_tx_hash,
    data -> 'batch_details' ->> 'verify_tx_hash' as verify_tx_hash,
    data -> 'batch_details' ->> 'execute_tx_hash' as execute_tx_hash,
    data -> 'blocks' as blocks,
    data -> 'status_changes' as status_changes,
    _loaded_at
from {{ source('lighter', 'batches') }}
