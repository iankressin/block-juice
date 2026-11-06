-- Lists each feed whose latest round is more than twice its heartbeat older than the latest round loaded
-- on its chain.
{{ config(severity='warn') }}
with latest_rounds as (
    select chain, proxy, feed, max(updated_at) as updated_at
    from {{ ref('oracle_prices') }}
    group by chain, proxy, feed
),

latest_blocks as (
    select chain, max(block_timestamp) as block_timestamp
    from {{ ref('oracle_prices') }}
    group by chain
),

heartbeats as (
    select chain, proxy, max(heartbeat_seconds) as heartbeat_seconds
    from {{ ref('chainlink_feeds') }}
    group by chain, proxy
)

select
    latest_rounds.chain,
    latest_rounds.feed,
    latest_rounds.proxy,
    latest_rounds.updated_at,
    latest_blocks.block_timestamp,
    heartbeats.heartbeat_seconds
from latest_rounds
inner join latest_blocks on latest_blocks.chain = latest_rounds.chain
inner join heartbeats on heartbeats.chain = latest_rounds.chain and heartbeats.proxy = latest_rounds.proxy
where latest_rounds.updated_at
    < latest_blocks.block_timestamp - 2 * heartbeats.heartbeat_seconds * interval '1 second'
