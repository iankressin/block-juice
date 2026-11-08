-- One row per UTC midnight on Solana, from the first to the last midnight the header source recorded:
-- whether its boundary slot B is proved, and if not, which checks failed. Slots can be skipped, so the slot
-- before B is the one Portal's header of B names as its parent, and the RPC header of B must name the same.
-- The checks are in macros/transfer_share.sql.
{{ transfer_share_day_boundaries(
    chain='solana',
    boundaries=ref('stg_solana__block_headers_boundaries'),
    headers=ref('stg_solana__block_headers'),
    previous_block='portal_boundary.parent_number'
) }}
