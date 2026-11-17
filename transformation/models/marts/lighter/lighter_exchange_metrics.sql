-- One daily Lighter exchange metric. day is the UTC day, kind names the metric, and market is the
-- symbol for a per-market series and null for an exchange-wide one. Only ended days load.
select
    id,
    day,
    kind,
    market,
    value
from {{ ref('stg_lighter__exchange_metrics') }}
