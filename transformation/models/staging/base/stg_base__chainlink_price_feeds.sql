select
    id,
    data,
    _loaded_at
from {{ source('base', 'chainlink_price_feeds') }}
