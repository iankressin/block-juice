-- Lighter's tx count for each closed UTC hour since 2025-10-02. hour is the start of the hour.
select
    hour,
    tx_count,
    uops_count
from {{ ref('stg_lighter__tx_stats') }}
