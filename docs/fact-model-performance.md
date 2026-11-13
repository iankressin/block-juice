# Fact model performance

`erc20_transfers`, `dex_trades`, `oracle_prices` and `token_prices` keep complete table builds by default. Each build runs `ANALYZE`, so downstream queries see current statistics immediately. Extra indexes and incremental writes are opt-in: measured read benefits come with model-build costs. Uniqueness checks remain in the existing dbt tests.

Existing staging and intermediate views remain live. After ingestion, `dbt run --select erc20_transfers` still reads the new raw records without requiring an upstream rebuild. Source names, model names, output columns and numeric precision are unchanged.

## Optional indexes for repeated window queries

Pass the YAML boolean `fact_indexes: true` to create `(chain, token, block_number)` on transfers, matching `token_transfers()`, and `(chain, version, block_number)` on DEX trades, matching the UNI swap analyses:

```sh
dbt run --select erc20_transfers dex_trades --vars '{fact_indexes: true}'
```

These are the only added read indexes. They made selective queries much faster on the synthetic workload, but index construction made table builds slower, so they are disabled by default. Reconciliation can reuse them with `--vars '{fact_strategy: reconcile, fact_indexes: true}'`. Existing indexes survive reconciliation; a normal table build or `--full-refresh` with `fact_indexes: false` removes the optional indexes.

## Optional reduction in persistent writes

On the repository's PostgreSQL 16 stack, pass `fact_strategy: reconcile` to update only changed fact rows:

```sh
dbt run --select erc20_transfers dex_trades oracle_prices token_prices \
  --vars '{fact_strategy: reconcile}'
```

The usual first-build requirement still applies: create upstream relations with `dbt run --select +erc20_transfers` (or the corresponding pipeline) before selecting a mart alone. The setting applies only to these four facts and is opt-in on every invocation. It can also be set under `vars` in `transformation/dbt_project.yml`. Use `fact_strategy: table`, or omit the setting, to return to full table builds. `--full-refresh` works in either mode.

Reconciliation computes the complete candidate result in a temporary table, validates its keys, merges new and changed rows, and deletes rows absent from the candidate. It adds an index on the existing documented unique key. Publishing these changes is transactional. A failed candidate leaves the previously published table intact. Unchanged rows and existing indexes survive; switching from a table build reuses equivalent indexes. An advisory lock serializes ordinary reconciliation runs on an existing fact before they compute their candidates. dbt resolves relations before that hook: coordinate first creation, full refresh, schema changes and invocations that use different strategies. Normal table rebuilds retain dbt's existing concurrency behavior.

This saves writes to persistent fact tables, but still scans the complete inputs and writes a temporary candidate. It is not a bounded-input incremental algorithm or a guarantee of lower total WAL. In the synthetic benchmark below, it eliminated all 200,000 target inserts on a no-op run and updated exactly 100 target rows after 100 corrections. It took longer than a table build, so it is not the default. Choose it only when avoiding persistent rewrites matters more than the measured build-time cost for your workload.

dbt's adapter `rows_affected` reports the final `MERGE`'s inserted and updated rows. It excludes the separate deletion statement; use the benchmark's PostgreSQL tuple counters when measuring all three kinds of persistent writes.

## Correctness limits on automatic incremental conversion

A `max(block_number)` filter misses late historical rows and corrections. A `max(_loaded_at)` filter can also miss committed data: ingestion uses the transaction's start time, and an older transaction can commit after a newer one. Neither timestamp captures changes to a seed, a pool's tokens, an address label or a market resolution that revalues old rows.

The regression fixture checks old late transfers, same-timestamp corrections, removed candles, changed Chainlink decimals and corrected Uniswap pool metadata. Both strategies produce the same rows as a full refresh, including large exact numeric values. Invalid duplicate keys roll back. A genuine bounded-input implementation would need a durable change stream with deletion events and dependency invalidation; the current raw-table contract does not provide one.

Converting live staging views to persisted tables would also change existing direct model-selection behavior and can drop unselected dependent views during dbt's view-to-table migration. These views therefore remain live. Reusing a projection within a query is compatible; silently introducing stale intermediate caches is not.

| Model family | Fact-layer disposition |
| --- | --- |
| Transfers | Keep live per-chain projections; analyze the shared typed mart, with an optional measured selector index. Exact write reconciliation is available. Classification and labels remain separate dependencies. |
| DEX | Keep live pool and transaction joins so late pool/receipt metadata propagates. Offer a measured chain/version/block selector index; exact reconciliation compares the final joined result. |
| Oracle prices | Recompute seed-dependent phase IDs and decimal scaling from current inputs. Current statistics; no default index for the full-input heartbeat aggregation. Reconciliation indexes the existing key. |
| Exchange candles | Retain corrections and deletions, including historical candles. Reconciliation indexes the documented candle key and compares the whole result. No speculative default indexes. |
| Balances, account state, tokens and address code | Retain live staging projections and highest-block/latest-observation inputs. Append-only conversion would miss corrections or change tie winners. Their current-state query optimizations are independent of this fact policy. |
| Bridges, CoW and deployments | Retain live staging and transaction/event joins. Candidate withdrawals, late trade receipts and failed ancestor traces can change historical results; they do not qualify for an event-time watermark. |
| Polymarket | Retain live Gamma and event projections. Late token metadata, redemption and resolution updates affect existing positions; no append-only or hidden cached-state conversion. |

## Reproduce the measurements

The benchmark creates and deletes its own database on the server named by `WAREHOUSE_HOST`, `WAREHOUSE_PORT`, `WAREHOUSE_USER` and `WAREHOUSE_PASSWORD`. Use a disposable PostgreSQL server with `CREATEDB` permission. It never connects to `WAREHOUSE_DB` or modifies an existing warehouse.

```sh
uv run --project orchestration python transformation/benchmarks/facts.py \
  --rows 200000 --repeats 3 > fact-benchmark.json
```

It records dbt node durations, persistent target insert/update/delete counts, and `EXPLAIN (ANALYZE, BUFFERS)` plans. Strategies use separate schemas and rotate execution order to reduce shared-host timing bias. The transfer test executes the real model. The DEX access-path fixture uses the same typed columns and predicate as the UNI analyses; it does not simulate complete ingestion or DEX build throughput. Results depend on hardware, cache state and concurrent activity.

On PostgreSQL 16 with 200,000 synthetic rows, the median of three interleaved executions was:

| Policy | No-op build | Build after 100 corrections | Persistent target writes after corrections |
| --- | ---: | ---: | --- |
| Previous table build | 0.648 s | 0.795 s | 200,000 inserts |
| Default table + `ANALYZE` | 0.869 s | 0.942 s | 200,000 inserts |
| Table + optional read indexes | 1.256 s | 1.240 s | 200,000 inserts |
| Optional reconciliation | 1.988 s | 2.295 s | 100 updates |

The default pays a statistics-collection cost to make typed-column statistics available immediately; it does not claim a faster build. Reconciliation's no-op run wrote zero target tuples. The transfer selector changed from 14.439 ms / 4,672 shared buffer accesses under the default to 0.505 ms / 106 accesses with the optional index. The DEX window predicate changed from 14.458 ms / 2,496 accesses to 0.430 ms / 38 accesses. Buffer counts include hits and reads. These are selective-query measurements, not whole-pipeline speedup claims. Complete table rebuilds remained faster than exact reconciliation, which is why both additional policies are opt-in.
