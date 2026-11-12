-- One row per value movement that touches a wallet in seeds/wallet_labels, seen from the labelled entity's
-- side, on every chain the sources cover. A movement is either a successful top-level transaction with value
-- > 0 from wallet_transactions (asset 'native', value in wei; internal transfers, which only traces show, are
-- not here) or an ERC-20 Transfer from erc20_transfers (asset is the token's address, value in its base
-- units). id is the movement's id in its mart: tx:<hash> for a transaction, <block>:<logIndex> for a log.
--
-- direction is 'inflow' when the receiver is the entity's and the sender is not, 'outflow' when the sender
-- is the entity's and the receiver is not, and 'intra' when both are. wallet is the entity's side (the
-- sender for intra), counterparty_address the other side, and counterparty_entity the other side's entity,
-- null when it has no label or for intra. A movement between two entities comes once for each, so a row is
-- unique by chain, id and entity.
--
-- The flows are complete only for the wallets the sources follow (their addresses.json), from their
-- START_BLOCK on. A labelled wallet no source follows shows only the movements that touch a followed one.
with labels as (
    select chain, lower(address) as address, entity
    from {{ ref('wallet_labels') }}
),

movements as (
    select
        chain,
        'tx:' || tx_hash as id,
        block_number,
        block_timestamp,
        tx_hash,
        null::integer as log_index,
        'native' as asset,
        from_address,
        to_address,
        value_wei as value
    from {{ ref('wallet_transactions') }}
    where succeeded and value_wei > 0

    union all

    select chain, id, block_number, block_timestamp, tx_hash, log_index, token, from_address, to_address, value
    from {{ ref('erc20_transfers') }}
),

labelled as (
    select m.*, fl.entity as from_entity, tl.entity as to_entity
    from movements as m
    left join labels as fl on fl.chain = m.chain and fl.address = m.from_address
    left join labels as tl on tl.chain = m.chain and tl.address = m.to_address
    where fl.address is not null or tl.address is not null
),

sides as (
    select
        labelled.*,
        from_entity as entity,
        case when to_entity = from_entity then 'intra' else 'outflow' end as direction,
        from_address as wallet,
        to_address as counterparty_address,
        case when to_entity is distinct from from_entity then to_entity end as counterparty_entity
    from labelled
    where from_entity is not null

    union all

    select
        labelled.*,
        to_entity as entity,
        'inflow' as direction,
        to_address as wallet,
        from_address as counterparty_address,
        from_entity as counterparty_entity
    from labelled
    where to_entity is not null and to_entity is distinct from from_entity
)

select
    chain,
    id,
    block_number,
    block_timestamp,
    tx_hash,
    log_index,
    asset,
    from_address,
    to_address,
    value,
    entity,
    direction,
    wallet,
    counterparty_address,
    counterparty_entity
from sides
