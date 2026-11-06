select
    id,
    data,
    _loaded_at
from {{ source('ethereum', 'chainlink_price_feeds') }}
