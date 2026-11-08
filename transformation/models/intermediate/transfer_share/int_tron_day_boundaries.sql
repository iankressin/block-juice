-- One row per UTC midnight on TRON, from the first to the last midnight the header source recorded: whether
-- its boundary block B is proved, and if not, which checks failed. The block before B is B - 1. The checks
-- are in macros/transfer_share.sql.
{{ transfer_share_day_boundaries(
    chain='tron',
    boundaries=ref('stg_tron__block_headers_boundaries'),
    headers=ref('stg_tron__block_headers'),
    previous_block='recorded.boundary_block - 1'
) }}
