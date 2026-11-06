select
    id,
    data,
    _loaded_at
from {{ source('arbitrum', 'chainlink_price_feeds') }}
