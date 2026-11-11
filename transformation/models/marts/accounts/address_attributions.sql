-- One row per address that a public body attributes to an incident, from seeds/attributed_addresses:
-- the chain, the address lowercased, the address as published, the incident (attribution), who
-- attributed it and when they published it.
select
    chain,
    lower(address) as address,
    published_address,
    attribution,
    attributed_by,
    published
from {{ ref('attributed_addresses') }}
