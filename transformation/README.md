# Transformation

dbt models that read each source's raw table and build the marts consultants query.

## Adding a chain

`bj new-source` already scaffolds the dbt sources YAML, a staging model that selects `id`, `data` and `_loaded_at` from that source, and the Dagster `SOURCES` entry. See `orchestration/pipeline/cli/new_source.py`. It does not add the chain to a mart.

The remaining steps, by hand:

1. Add `int_<chain>_balances.sql` and its contract YAML, copied from an existing chain in `models/intermediate/balances/`. The contract names any missing or mistyped column at build time.
2. Add a `union all` branch for that model in `models/marts/balances/latest_balances.sql`.
3. Add the chain to the `accepted_values` of `chain` in `models/marts/balances/_balances__models.yml`.
