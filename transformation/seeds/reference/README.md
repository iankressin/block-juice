# Reference seeds

Each seed here is the expected answer to one factory ticket over its eval window. The ticket's scope run computed it from an oracle that does not read this warehouse, and its build run copied it here from the scope comment. [docs/agents/factory.md](../../../docs/agents/factory.md) has the contract.

For a ticket whose answer has the slug `<slug>`, with `<name>` the slug with `_` for `-`:

- The seed is `reference_<name>.csv`: the key columns and the value column, one row per expected result.
- `_reference_seeds.yml` registers it, with a description that names the oracle, the window and the ticket.
- The test is `../../tests/reference/<name>_matches_reference.sql`, tagged `reference`. It calls the `reference_mismatches` macro, which returns one row per key that is missing on either side or whose value is over the tolerance, with the columns `expected`, `actual` and `reason`.

`bj answer` does not run these tests. Run them with `dbt test --select tag:reference`.

## Example

Ticket #12 asks how many Uniswap v3 swaps each pool had on Ethereum on 2026-10-15, with the slug `uni-v3-swaps-2026-10-15`. The scope run counted them with a Dune query. The build run adds `reference_uni_v3_swaps_2026_10_15.csv`:

```csv
pool,swaps
0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640,4127
0x11b815efb8f581194ae79006d24e0d814b7697f6,2210
```

It registers the seed in `_reference_seeds.yml`:

```yaml
version: 2

seeds:
  - name: reference_uni_v3_swaps_2026_10_15
    description: >-
      #12: swaps per Uniswap v3 pool on Ethereum blocks 23580000 to 23587000 (2026-10-15 UTC), from Dune
      query 1234567.
    config:
      column_types:
        pool: text
        swaps: numeric
```

And it writes `tests/reference/uni_v3_swaps_2026_10_15_matches_reference.sql`:

```sql
{{ config(tags=['reference']) }}
-- #12: swaps per Uniswap v3 pool, verified on ethereum blocks 23580000 to 23587000 against Dune query 1234567.
with actual as (
    select pool, count(*) as swaps
    from {{ ref('dex_trades') }}
    where chain = 'ethereum' and version = 'v3' and block_number between 23580000 and 23587000
    group by pool
)
{{ reference_mismatches(ref('reference_uni_v3_swaps_2026_10_15'), 'actual', ['pool'], 'swaps', 'absolute', 0) }}
```

The key columns of the seed and of `actual` need the same names and types that compare. Give an address key `text` in `column_types`, or dbt may guess another type.
